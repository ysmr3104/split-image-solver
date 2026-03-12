#!/usr/bin/env python3
"""
Split Image Solver - メインスクリプト
広角星空画像を分割してプレートソルブし、統合したWCS情報を元画像に書き込む
"""

import argparse
import json
import math
import re
import sys
import tempfile
import shutil
from pathlib import Path
from typing import Dict
import numpy as np

from image_splitter import ImageSplitter, load_image
from solvers.factory import create_solver
from wcs_integrator import WCSIntegrator
from fits_handler import FITSHandler
from utils.logger import setup_logger, get_logger


def _sanitize_floats_for_pjsr(obj):
    """PJSR の JSON.parse 互換のために浮動小数点精度を制限する

    PJSR は小数点以下18桁以上の数値や科学表記(1.23e-06等)を解析できないため、
    全浮動小数点数を12有効桁・最大15桁小数に丸める。
    """
    if isinstance(obj, dict):
        return {k: _sanitize_floats_for_pjsr(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_sanitize_floats_for_pjsr(v) for v in obj]
    elif isinstance(obj, float):
        if obj == 0.0:
            return 0.0
        try:
            magnitude = math.floor(math.log10(abs(obj)))
        except ValueError:
            return 0.0
        # 12有効桁、最大15桁小数
        decimal_places = max(0, min(15, 12 - int(magnitude) - 1))
        return round(obj, decimal_places)
    return obj


def _json_dumps_pjsr_safe(obj):
    """PJSR 互換の JSON 文字列を生成する

    1. 全浮動小数点数を12有効桁に丸める（小数点以下15桁以下に収める）
    2. 残った科学表記を固定小数点に変換する
    """
    safe_obj = _sanitize_floats_for_pjsr(obj)
    json_str = json.dumps(safe_obj)

    # 科学表記が残っている場合は固定小数点に変換
    def _sci_to_fixed(match):
        val = float(match.group(0))
        if val == 0:
            return "0.0"
        s = f"{val:.15f}".rstrip("0")
        if s.endswith("."):
            s += "0"
        return s

    return re.sub(r"-?\d+\.?\d*[eE][+-]?\d+", _sci_to_fixed, json_str)


def _parse_grid(grid_str: str):
    """グリッドパターン文字列 (例: '8x8') を (rows, cols) に変換"""
    parts = grid_str.lower().split("x")
    cols = int(parts[0])
    rows = int(parts[1]) if len(parts) > 1 else cols
    return rows, cols


def _build_tile_grid(grid_rows, grid_cols, split_files, solve_results,
                     skipped_indices=None):
    """タイル成否の2Dグリッドを生成

    Returns:
        List[List[str]]: 各セルが "O"(成功) / "X"(失敗) / "-"(スキップ) の2Dリスト
    """
    grid = [["X"] * grid_cols for _ in range(grid_rows)]
    if skipped_indices:
        for row, col in skipped_indices:
            if 0 <= row < grid_rows and 0 <= col < grid_cols:
                grid[row][col] = "-"
    for sf in split_files:
        row, col = sf["region"]["index"]
        path = str(sf["file_path"])
        result = solve_results.get(path)
        if result and result.get("success"):
            grid[row][col] = "O"
    return grid


def _build_solver_config(config: Dict) -> Dict:
    """astrometry_local用の設定辞書を構築する"""
    return {
        "solve_field_path": config.get("astrometry_local", {}).get("solve_field_path"),
        "timeout": config.get("astrometry_local", {}).get("timeout", 600),
        "search_radius": config.get("astrometry_local", {}).get("search_radius", 10.0),
    }


def load_config(config_path: Path) -> Dict:
    """設定ファイルを読み込む"""
    if not config_path.exists():
        logger = get_logger()
        logger.warning(f"Config file not found: {config_path}, using defaults")
        return {}

    with open(config_path, "r") as f:
        return json.load(f)


def _handle_list_equipment(args) -> int:
    """--list-equipment: 機材データベースをJSON出力"""
    from utils.equipment import load_equipment_db

    equipment_db_path = Path(args.equipment_db) if args.equipment_db else None
    db = load_equipment_db(equipment_db_path)

    # JS側で使いやすい形式に変換
    output = {"cameras": {}, "lenses": {}}
    for name, cam in db.get("cameras", {}).items():
        output["cameras"][name] = {
            "display_name": cam.get("display_name", name),
            "pixel_pitch_um": cam.get("pixel_pitch_um"),
            "sensor_width_mm": cam.get("sensor_width_mm"),
        }
    for name, lens in db.get("lenses", {}).items():
        output["lenses"][name] = {
            "display_name": lens.get("display_name", name),
            "focal_length_mm": lens.get("focal_length_mm"),
            "type": lens.get("type", "rectilinear"),
        }

    print(json.dumps(output))
    return 0


def _handle_recommend_grid(args) -> int:
    """--recommend-grid: 推奨グリッドサイズをJSON出力"""
    from utils.coordinate_transform import (
        LENS_TYPE_TO_PROJECTION,
        _pixel_radius_to_angle,
    )

    focal_length = args.focal_length
    pixel_pitch = args.pixel_pitch
    image_width = args.image_width
    image_height = args.image_height
    lens_type = args.lens_type

    if not focal_length or not pixel_pitch:
        print(
            json.dumps(
                {
                    "error": "--focal-length and --pixel-pitch are required for --recommend-grid"
                }
            )
        )
        return 1

    # ピクセルスケール (arcsec/pixel)
    pixel_scale = (206.265 * pixel_pitch) / focal_length
    projection = LENS_TYPE_TO_PROJECTION.get(lens_type, "gnomonic")

    result = {
        "pixel_scale_arcsec": round(pixel_scale, 4),
        "lens_type": lens_type,
        "projection": projection,
    }

    if image_width and image_height:
        # 対角ピクセル数
        diag_pixels = (image_width**2 + image_height**2) ** 0.5
        scale_rad = np.radians(pixel_scale / 3600.0)

        # 投影型に応じた正確な対角FOV計算
        diag_angle_rad = _pixel_radius_to_angle(
            diag_pixels / 2.0, scale_rad, projection
        )
        diag_fov = np.degrees(diag_angle_rad) * 2.0

        # 推奨グリッドサイズ（対角FOV基準）
        if diag_fov > 150:
            recommended = "12x8"
        elif diag_fov > 120:
            recommended = "10x10"
        elif diag_fov > 90:
            recommended = "8x8"
        elif diag_fov > 60:
            recommended = "5x5"
        elif diag_fov > 30:
            recommended = "3x3"
        else:
            recommended = "2x2"

        result["image_width"] = image_width
        result["image_height"] = image_height
        result["diagonal_fov_deg"] = round(diag_fov, 2)
        result["recommended_grid"] = recommended

    print(json.dumps(result))
    return 0


def run_tile_solve_mode(args) -> int:
    """--tile-solve-json モード: タイルFITSを並列ソルブし per-tile WCS を JSON 出力する。

    WCS 統合（WCSIntegrator）は実行しない。統合は JS 側の mergeWcsSolutions() が担う。

    Input JSON format (list):
        [{"path": str, "row": int, "col": int,
          "ra_hint": float|null, "dec_hint": float|null,
          "scale_lower": float|null, "scale_upper": float|null,
          "offset_x": float, "offset_y": float,
          "tile_width": int, "tile_height": int}, ...]

    Output JSON format:
        {"success": bool, "tiles_solved": int, "tiles_total": int,
         "tile_results": [{"row": int, "col": int, "success": bool,
                           "crval1": float, "crval2": float,
                           "crpix1": float, "crpix2": float,
                           "cd1_1": float, "cd1_2": float,
                           "cd2_1": float, "cd2_2": float,
                           "pixel_scale": float|null,
                           "sip_order": int, "sip_a": dict, "sip_b": dict}, ...]}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # ログはすべて stderr へ (stdout は使わない)
    logger = setup_logger(
        level=args.log_level,
        log_file=args.log_file,
        console_output=True,
        use_stderr=True,
    )

    def _write_result(result_dict):
        json_str = _json_dumps_pjsr_safe(result_dict)
        if args.result_file:
            try:
                with open(args.result_file, "w", encoding="utf-8") as rf:
                    rf.write(json_str)
            except Exception as e:
                logger.error(f"Failed to write result file: {e}")
        else:
            print(json_str)
            sys.stdout.flush()

    # 入力 JSON を読み込む
    input_path = Path(args.tile_solve_json)
    if not input_path.exists():
        err = {"success": False, "error": f"Input JSON not found: {input_path}"}
        _write_result(err)
        return 1

    try:
        tile_requests = json.loads(input_path.read_text(encoding="utf-8"))
    except Exception as e:
        err = {"success": False, "error": f"Failed to parse input JSON: {e}"}
        _write_result(err)
        return 1

    if not tile_requests:
        err = {"success": False, "error": "No tiles in input JSON"}
        _write_result(err)
        return 1

    logger.info("=" * 60)
    logger.info("Tile Solve Mode - Starting")
    logger.info(f"Tiles: {len(tile_requests)}")
    logger.info("=" * 60)

    # 設定ファイルを読み込む
    config_path = Path(args.config)
    config = load_config(config_path)
    solver_config = _build_solver_config(config)
    solver = create_solver(**solver_config)

    def _solve_one(req):
        """単一タイルをソルブし (row, col, result_dict) を返す"""
        tile_path = Path(req["path"])
        row = req["row"]
        col = req["col"]
        ra_hint = req.get("ra_hint")
        dec_hint = req.get("dec_hint")
        scale_lower = req.get("scale_lower")
        scale_upper = req.get("scale_upper")
        tile_width = req.get("tile_width", 0)
        tile_height = req.get("tile_height", 0)

        # タイル寸法が未指定なら FITS ヘッダーから取得
        if not tile_width or not tile_height:
            try:
                from astropy.io import fits as afits
                with afits.open(str(tile_path)) as hdul:
                    tile_width = hdul[0].header.get("NAXIS1", 0)
                    tile_height = hdul[0].header.get("NAXIS2", 0)
            except Exception:
                pass

        # ダウンサンプル判定: 元タイルサイズが2000超なら、
        # FITS が既にダウンサンプル済みでも solve-field の --downsample を付与
        # （ソース抽出の品質向上のため）
        downsample = None
        original_longer = max(tile_width, tile_height)
        if original_longer > 2000:
            import math
            downsample = max(2, math.ceil(original_longer / 2000))

        try:
            result = solver.solve_image(
                tile_path,
                ra_hint=ra_hint,
                dec_hint=dec_hint,
                scale_lower=scale_lower,
                scale_upper=scale_upper,
                downsample=downsample,
            )
        except Exception as e:
            result = {"success": False, "error_message": str(e), "wcs": None}

        result["_req"] = req
        return row, col, result

    # Pass 1: 並列ソルブ
    logger.info(f"\n[Pass 1] Solving {len(tile_requests)} tiles in parallel...")
    solve_results = {}  # (row, col) -> result dict

    with ThreadPoolExecutor(max_workers=4) as executor:
        future_map = {executor.submit(_solve_one, req): req for req in tile_requests}
        for future in as_completed(future_map):
            row, col, result = future.result()
            solve_results[(row, col)] = result
            if result["success"]:
                logger.info(
                    f"  [{row}][{col}] OK  RA={result.get('ra_center', 0):.3f}° "
                    f"DEC={result.get('dec_center', 0):+.3f}° "
                    f"scale={result.get('pixel_scale', 0):.2f}\"/px"
                )
            else:
                logger.info(
                    f"  [{row}][{col}] FAIL {result.get('error_message', 'unknown')[:80]}"
                )

    success_count = sum(1 for r in solve_results.values() if r["success"])
    logger.info(f"Pass 1: {success_count}/{len(tile_requests)} tiles solved")

    # Pass 2: 失敗タイルを成功タイルの WCS から得た精密ヒントでリトライ
    failed_keys = [(row, col) for (row, col), r in solve_results.items() if not r["success"]]

    if failed_keys and success_count > 0:
        logger.info(
            f"\n[Pass 2] Retrying {len(failed_keys)} failed tiles with WCS-derived hints..."
        )

        # 成功タイルの参照情報 (全画像座標での中心 + WCS)
        success_refs = []
        success_scales = []
        for (row, col), r in solve_results.items():
            if not r["success"]:
                continue
            req = r["_req"]
            offset_x = req.get("offset_x", 0)
            offset_y = req.get("offset_y", 0)
            tw = req.get("tile_width", 0)
            th = req.get("tile_height", 0)
            success_refs.append({
                "row": row, "col": col,
                "cx": offset_x + tw / 2.0,
                "cy": offset_y + th / 2.0,
                "offset_x": offset_x,
                "offset_y": offset_y,
                "wcs": r["wcs"],
            })
            if r.get("pixel_scale"):
                success_scales.append(r["pixel_scale"])

        median_scale = float(np.median(success_scales)) if success_scales else None

        retry_futures = {}
        with ThreadPoolExecutor(max_workers=4) as executor:
            for (row, col) in failed_keys:
                req = solve_results[(row, col)]["_req"]
                offset_x = req.get("offset_x", 0)
                offset_y = req.get("offset_y", 0)
                tw = req.get("tile_width", 0)
                th = req.get("tile_height", 0)
                cx = offset_x + tw / 2.0
                cy = offset_y + th / 2.0

                # 最も近い成功タイルを選択
                nearest = min(
                    success_refs,
                    key=lambda ref: (cx - ref["cx"]) ** 2 + (cy - ref["cy"]) ** 2,
                )
                ref_wcs = nearest["wcs"]

                # 失敗タイルの中心を参照タイルのローカル座標に変換して RA/DEC を取得
                local_x = cx - nearest["offset_x"]
                local_y = cy - nearest["offset_y"]
                try:
                    tile_ra, tile_dec = ref_wcs.pixel_to_world_values(local_x, local_y)
                    tile_ra = float(tile_ra) % 360.0
                    tile_dec = float(tile_dec)
                except Exception as e:
                    logger.warning(f"  [{row}][{col}] WCS hint failed: {e}")
                    continue

                logger.info(
                    f"  [{row}][{col}] retry hint RA={tile_ra:.3f}° DEC={tile_dec:+.3f}°"
                )

                new_req = dict(req)
                new_req["ra_hint"] = tile_ra
                new_req["dec_hint"] = tile_dec
                # Pass 2 ではスケールマージンを ±50% に拡大
                # (full pipeline の 2nd pass と同じ)
                orig_lower = req.get("scale_lower")
                orig_upper = req.get("scale_upper")
                if orig_lower and orig_upper:
                    mid = (orig_lower + orig_upper) / 2.0
                    new_req["scale_lower"] = mid * 0.5
                    new_req["scale_upper"] = mid * 1.5
                f = executor.submit(_solve_one, new_req)
                retry_futures[f] = (row, col)

            for future in as_completed(retry_futures):
                row, col = retry_futures[future]
                _, _, result = future.result()
                if result["success"]:
                    # 偽陽性フィルタ: スケール比チェック
                    is_valid = True
                    if median_scale and result.get("pixel_scale"):
                        ratio = result["pixel_scale"] / median_scale
                        if ratio < 0.3 or ratio > 3.0:
                            is_valid = False
                            logger.warning(
                                f"  [{row}][{col}] 2nd pass REJECTED: "
                                f"scale ratio={ratio:.2f} (median={median_scale:.2f}\"/px)"
                            )
                    if is_valid:
                        solve_results[(row, col)] = result
                        logger.info(
                            f"  [{row}][{col}] 2nd pass OK  "
                            f"RA={result.get('ra_center', 0):.3f}° "
                            f"DEC={result.get('dec_center', 0):+.3f}°"
                        )
                else:
                    logger.debug(f"  [{row}][{col}] 2nd pass FAIL")

        success_count = sum(1 for r in solve_results.values() if r["success"])
        logger.info(f"Total: {success_count}/{len(tile_requests)} tiles solved")

    # per-tile WCS を抽出して出力データを構築
    tile_results = []
    for req in tile_requests:
        row = req["row"]
        col = req["col"]
        r = solve_results.get((row, col))

        if not r:
            tile_results.append({"row": row, "col": col, "success": False, "error": "no result"})
            continue

        if not r["success"]:
            tile_results.append({
                "row": row, "col": col, "success": False,
                "error": r.get("error_message", "solve failed"),
            })
            continue

        # astropy WCS から CRVAL / CRPIX / CD 行列を抽出
        wcs = r["wcs"]
        try:
            crval1 = float(wcs.wcs.crval[0])
            crval2 = float(wcs.wcs.crval[1])
            crpix1 = float(wcs.wcs.crpix[0])
            crpix2 = float(wcs.wcs.crpix[1])

            # CD 行列: cd 属性があれば直接使用、なければ PC * CDELT から算出
            if hasattr(wcs.wcs, "cd") and wcs.wcs.cd is not None and wcs.wcs.cd.size > 0:
                cd = wcs.wcs.cd
                cd1_1 = float(cd[0, 0])
                cd1_2 = float(cd[0, 1])
                cd2_1 = float(cd[1, 0])
                cd2_2 = float(cd[1, 1])
            else:
                cdelt = wcs.wcs.cdelt
                pc = wcs.wcs.get_pc()
                cd1_1 = float(cdelt[0] * pc[0, 0])
                cd1_2 = float(cdelt[0] * pc[0, 1])
                cd2_1 = float(cdelt[1] * pc[1, 0])
                cd2_2 = float(cdelt[1] * pc[1, 1])

            entry = {
                "row": row, "col": col, "success": True,
                "crval1": crval1, "crval2": crval2,
                "crpix1": crpix1, "crpix2": crpix2,
                "cd1_1": cd1_1, "cd1_2": cd1_2,
                "cd2_1": cd2_1, "cd2_2": cd2_2,
                "pixel_scale": float(r["pixel_scale"]) if r.get("pixel_scale") else None,
            }

            # SIP 係数があれば含める
            if wcs.sip is not None:
                try:
                    def _sip_dict(arr):
                        d = {}
                        for i in range(arr.shape[0]):
                            for j in range(arr.shape[1]):
                                if arr[i, j] != 0.0:
                                    d[f"{i}_{j}"] = float(arr[i, j])
                        return d
                    entry["sip_order"] = int(wcs.sip.a_order)
                    entry["sip_a"] = _sip_dict(wcs.sip.a)
                    entry["sip_b"] = _sip_dict(wcs.sip.b)
                except Exception:
                    pass

            tile_results.append(entry)

        except Exception as e:
            logger.warning(f"  [{row}][{col}] WCS extraction failed: {e}")
            tile_results.append({
                "row": row, "col": col, "success": False,
                "error": f"WCS extraction failed: {e}",
            })

    output = {
        "success": True,
        "tiles_solved": success_count,
        "tiles_total": len(tile_requests),
        "tile_results": tile_results,
    }
    _write_result(output)
    logger.info("Tile solve mode completed.")
    return 0


def main():
    """メインエントリーポイント"""
    parser = argparse.ArgumentParser(
        description="Split Image Solver - 広角星空画像の分割プレートソルブ"
    )

    # 入出力（--list-equipment / --recommend-grid 使用時は不要）
    parser.add_argument("--input", type=str, help="入力FITS/XISF画像パス")
    parser.add_argument("--output", type=str, help="出力FITS/XISF画像パス")

    # ユーティリティモード
    parser.add_argument(
        "--list-equipment",
        action="store_true",
        help="機材データベースをJSON出力して終了",
    )
    parser.add_argument(
        "--recommend-grid",
        action="store_true",
        help="推奨グリッドサイズをJSON出力して終了",
    )
    parser.add_argument(
        "--image-width", type=int, help="画像幅 (px) - --recommend-grid用"
    )
    parser.add_argument(
        "--image-height", type=int, help="画像高さ (px) - --recommend-grid用"
    )

    # 分割設定
    parser.add_argument(
        "--grid",
        type=str,
        default="2x2",
        help="分割グリッドパターン (例: 2x2, 3x3, 2x4) [デフォルト: 2x2]",
    )
    parser.add_argument(
        "--overlap",
        type=int,
        default=100,
        help="オーバーラップピクセル数 [デフォルト: 100]",
    )

    # FOV/座標ヒント
    parser.add_argument(
        "--focal-length", type=float, help="焦点距離 (mm) - FOV計算に使用"
    )
    parser.add_argument(
        "--pixel-scale",
        type=float,
        help="ピクセルスケール (arcsec/pixel) - 直接指定する場合",
    )
    parser.add_argument(
        "--pixel-pitch",
        type=float,
        help="ピクセルピッチ (μm) - --focal-lengthと組み合わせてピクセルスケール計算",
    )
    parser.add_argument(
        "--ra", type=float, help="視野中心の赤経 (degrees) - 例: バラ星雲は98度"
    )
    parser.add_argument(
        "--dec", type=float, help="視野中心の赤緯 (degrees) - 例: バラ星雲は+5度"
    )

    # WCS統合設定
    parser.add_argument(
        "--wcs-method",
        type=str,
        default="weighted_least_squares",
        choices=["weighted_least_squares", "central_tile"],
        help="WCS統合方法 [デフォルト: weighted_least_squares]",
    )
    parser.add_argument(
        "--overlap-tolerance",
        type=float,
        default=5.0,
        help="オーバーラップ検証の許容誤差（秒角） [デフォルト: 5.0]",
    )

    # 一時ファイル設定
    parser.add_argument(
        "--temp-dir",
        type=str,
        help="一時ファイルディレクトリ [デフォルト: システム一時ディレクトリ]",
    )
    parser.add_argument("--keep-temp", action="store_true", help="一時ファイルを保持")
    parser.add_argument(
        "--skip-edges",
        type=str,
        default=None,
        help="スキップするエッジタイル数 T,B,L,R (例: '0,3,0,0' = 下3行スキップ)",
    )

    # ログ設定
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="ログレベル [デフォルト: INFO]",
    )
    parser.add_argument("--log-file", type=str, help="ログファイルパス")

    # 機材指定
    parser.add_argument(
        "--camera",
        type=str,
        help="カメラモデル名 (例: 'Sony ILCE-7RM5'). 未指定時はヘッダーから自動検出",
    )
    parser.add_argument(
        "--lens",
        type=str,
        help="レンズモデル名 (例: 'Sony FE 14mm f/1.8 GM'). 未指定時は焦点距離から推定",
    )
    parser.add_argument(
        "--equipment-db",
        type=str,
        help="機材データベースYAMLパス [デフォルト: config/equipment.yaml]",
    )

    # レンズ投影型
    parser.add_argument(
        "--lens-type",
        type=str,
        default="rectilinear",
        help="レンズ投影型 (rectilinear, fisheye_equisolid, fisheye_equidistant, fisheye_stereographic)",
    )

    # タイルソルブ専用モード（PixInsight連携用）
    parser.add_argument(
        "--tile-solve-json",
        type=str,
        help="タイルソルブ専用モード: タイルFITSパスとヒントのJSONを受け取り、"
             "per-tile WCSをJSONで出力する（--result-fileと組み合わせて使用）。"
             "WCS統合は行わない。",
    )

    # 出力形式
    parser.add_argument(
        "--json-output",
        action="store_true",
        help="結果をJSON形式で標準出力に出力（PixInsight連携用）",
    )
    parser.add_argument(
        "--result-file",
        type=str,
        help="結果JSONの出力先ファイルパス（stdout出力の代替、PixInsight連携用）",
    )

    # 設定ファイル
    parser.add_argument(
        "--config", type=str, default="./config/settings.json", help="設定ファイルパス"
    )

    args = parser.parse_args()

    # ユーティリティモード: --list-equipment
    if args.list_equipment:
        return _handle_list_equipment(args)

    # ユーティリティモード: --recommend-grid
    if args.recommend_grid:
        return _handle_recommend_grid(args)

    # タイルソルブ専用モード: --tile-solve-json
    if args.tile_solve_json:
        return run_tile_solve_mode(args)

    # 通常モードでは --input / --output が必須
    if not args.input:
        parser.error("--input is required")
    if not args.output:
        parser.error("--output is required")

    # ロガーをセットアップ
    # --json-output時はstdoutをJSON専用にし、ログはstderrへ
    logger = setup_logger(
        level=args.log_level,
        log_file=args.log_file,
        console_output=True,
        use_stderr=args.json_output,
    )

    logger.info("=" * 60)
    logger.info("Split Image Solver - Starting")
    logger.info("=" * 60)

    # 設定ファイルを読み込み
    config_path = Path(args.config)
    config = load_config(config_path)

    # ソルバー設定の決定
    solver_config = _build_solver_config(config)

    # 入出力パス
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if not input_path.exists():
        logger.error(f"Input file not found: {input_path}")
        if args.json_output:
            print(
                json.dumps(
                    {"success": False, "error": f"Input file not found: {input_path}"}
                )
            )
        return 1

    # 一時ディレクトリ
    if args.temp_dir:
        temp_dir = Path(args.temp_dir)
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_base = str(temp_dir)
    else:
        temp_base = None

    # --keep-temp指定時は通常のディレクトリを使用（自動削除されない）
    if args.keep_temp:
        import datetime

        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        temp_dir_path = (
            Path(temp_base if temp_base else "/tmp") / f"split_solver_{timestamp}"
        )
        temp_dir_path.mkdir(parents=True, exist_ok=True)
        temp_dir_obj = None
    else:
        temp_dir_obj = tempfile.TemporaryDirectory(dir=temp_base)
        temp_dir_path = Path(temp_dir_obj.name)

    try:
        logger.info(f"Input: {input_path}")
        logger.info(f"Output: {output_path}")
        logger.info(f"Grid: {args.grid}, Overlap: {args.overlap}px")
        logger.info(f"Temp directory: {temp_dir_path}")

        # Step 1: 画像を読み込み
        logger.info("\n[Step 1/6] Loading input image...")

        # 入力ファイル形式を判定
        input_suffix = input_path.suffix.lower()
        input_format = "xisf" if input_suffix == ".xisf" else "fits"

        # 画像とメタデータを読み込み
        if input_format == "xisf":
            from xisf_handler import XISFHandler

            image_data, original_metadata = XISFHandler.load_image(input_path)
            original_header = XISFHandler.convert_to_fits_header(original_metadata)
        else:
            image_data, original_header = load_image(input_path)
            original_metadata = None

        # Step 1.5: 機材自動検出 + ピクセルスケール計算の準備
        from utils.equipment import (
            load_equipment_db,
            detect_equipment_from_header,
            lookup_camera,
            lookup_lens,
        )

        equipment_db_path = Path(args.equipment_db) if args.equipment_db else None
        equipment_db = load_equipment_db(equipment_db_path)

        camera_info, lens_info, header_params = detect_equipment_from_header(
            original_header, equipment_db
        )

        # CLI引数を取得
        pixel_scale = args.pixel_scale
        focal_length = args.focal_length
        pixel_pitch = args.pixel_pitch

        # CLI 指定があればそちらを優先
        if args.camera:
            camera_info = lookup_camera(equipment_db, args.camera)
            if camera_info:
                logger.info(
                    f"カメラ (CLI指定): {camera_info.get('display_name', args.camera)}"
                )
        if args.lens:
            lenses = equipment_db.get("lenses", {})
            for name, info in lenses.items():
                if args.lens.lower() in name.lower():
                    lens_info = info
                    logger.info(
                        f"レンズ (CLI指定): {info.get('display_name', args.lens)}"
                    )
                    break

        # 検出結果から pixel_pitch を取得（equipment DB を優先）
        if camera_info and camera_info.get("pixel_pitch_um"):
            db_pixel_pitch = camera_info["pixel_pitch_um"]
            if pixel_pitch and abs(pixel_pitch - db_pixel_pitch) / db_pixel_pitch > 0.1:
                logger.warning(
                    f"Pixel pitch mismatch: header/CLI={pixel_pitch:.2f}μm "
                    f"vs equipment DB={db_pixel_pitch:.2f}μm. Using DB value."
                )
            if not pixel_pitch:
                logger.info(f"Pixel pitch from equipment DB: {db_pixel_pitch:.2f} μm")
            pixel_pitch = db_pixel_pitch

        # 検出結果から焦点距離を取得
        if not focal_length and header_params.get("focal_length_mm"):
            focal_length = header_params["focal_length_mm"]
            logger.info(f"Focal length from header: {focal_length:.1f} mm")

        # F値の表示
        if header_params.get("f_number"):
            logger.info(f"F-number from header: f/{header_params['f_number']:.1f}")

        # 投影型の検出
        from utils.coordinate_transform import LENS_TYPE_TO_PROJECTION

        lens_type = lens_info.get("type", "rectilinear") if lens_info else "rectilinear"
        if args.lens_type != "rectilinear":
            lens_type = args.lens_type
        projection = LENS_TYPE_TO_PROJECTION.get(lens_type, "gnomonic")
        logger.info(f"Lens type: {lens_type} (projection: {projection})")

        if lens_type != "rectilinear":
            grid_rows_check, grid_cols_check = _parse_grid(args.grid)
            if grid_rows_check < 8 or grid_cols_check < 8:
                logger.warning(
                    f"魚眼レンズ検出: グリッド {args.grid} は小さい可能性があります。"
                    f"8x8 以上を推奨します。"
                )

        # Step 2: 画像を分割
        logger.info("\n[Step 2/6] Splitting image...")
        splitter = ImageSplitter(
            image_data=image_data,
            header=original_header,
            grid_pattern=args.grid,
            overlap_pixels=args.overlap,
            input_format=input_format,
            original_metadata=original_metadata,
        )

        split_dir = temp_dir_path / "splits"
        split_files = splitter.split_and_save(split_dir)

        if not split_files:
            logger.error("Image splitting failed")
            if args.json_output:
                print(json.dumps({"success": False, "error": "Image splitting failed"}))
            return 1

        logger.info(f"Image split into {len(split_files)} tiles")

        # Skip edges: スキップ対象タイルを除外
        skipped_indices = set()
        if args.skip_edges:
            try:
                parts = args.skip_edges.split(",")
                skip_top = int(parts[0])
                skip_bottom = int(parts[1])
                skip_left = int(parts[2])
                skip_right = int(parts[3])
            except (IndexError, ValueError):
                skip_top = skip_bottom = skip_left = skip_right = 0
                logger.warning(f"Invalid --skip-edges format: {args.skip_edges}, ignoring")

            grid_rows, grid_cols = _parse_grid(args.grid)
            for sf in split_files:
                row, col = sf["region"]["index"]
                if (row < skip_top or row >= grid_rows - skip_bottom or
                        col < skip_left or col >= grid_cols - skip_right):
                    skipped_indices.add((row, col))

            if skipped_indices:
                original_count = len(split_files)
                split_files = [
                    sf for sf in split_files
                    if sf["region"]["index"] not in skipped_indices
                ]
                logger.info(
                    f"Skip edges (T:{skip_top} B:{skip_bottom} L:{skip_left} R:{skip_right}): "
                    f"{original_count - len(split_files)} tiles skipped, "
                    f"{len(split_files)} tiles to solve"
                )

        # Step 3: 各分割画像をプレートソルブ
        logger.info(f"\n[Step 3/6] Plate solving tiles with astrometry_local...")
        solver = create_solver(**solver_config)

        # ピクセルスケールの決定
        if pixel_scale:
            logger.info(f"Pixel scale (center): {pixel_scale:.2f} arcsec/pixel")
        elif focal_length:
            # --pixel-pitch が指定されていればそれを使用、なければ sensor_width から推定
            if pixel_pitch:
                pixel_pitch_um = pixel_pitch
                logger.info(f"Using specified pixel pitch: {pixel_pitch_um:.2f} μm")
            else:
                sensor_width_mm = 35.9  # Sony α7 (full frame) フォールバック
                pixel_pitch_mm = sensor_width_mm / image_data.shape[1]
                pixel_pitch_um = pixel_pitch_mm * 1000
                logger.warning(
                    f"--pixel-pitch not specified, assuming sensor_width={sensor_width_mm}mm "
                    f"-> pixel_pitch={pixel_pitch_um:.2f}μm (use --pixel-pitch for accuracy)"
                )
            pixel_scale = (206.265 * pixel_pitch_um) / focal_length  # arcsec/pixel
            logger.info(
                f"Calculated from FOCALLEN={focal_length}mm: pixel_scale={pixel_scale:.2f} arcsec/pixel"
            )

        # タイルごとの実効スケール・FOV・マージンを計算
        from utils.coordinate_transform import (
            pixel_offset_to_radec,
            calculate_tile_center_offset,
            calculate_tile_pixel_scale,
        )

        image_width = image_data.shape[1]
        image_height = image_data.shape[0]
        image_center_x = image_width / 2.0
        image_center_y = image_height / 2.0
        # 画像コーナーまでの最大距離（マージン計算用）
        max_r_pixels = np.sqrt(image_center_x**2 + image_center_y**2)

        tile_fov_hints = []
        tile_scale_margins = []
        for sf in split_files:
            region = sf["region"]
            tile_cx = (region["x_start"] + region["x_end"]) / 2.0
            tile_cy = (region["y_start"] + region["y_end"]) / 2.0
            tile_w = region["x_end"] - region["x_start"]
            tile_h = region["y_end"] - region["y_start"]
            tile_longer = max(tile_w, tile_h)

            if pixel_scale:
                # タイル位置での実効ピクセルスケール
                effective_scale = calculate_tile_pixel_scale(
                    pixel_scale,
                    tile_cx,
                    tile_cy,
                    image_center_x,
                    image_center_y,
                    projection=projection,
                )
                tile_fov = (effective_scale * tile_longer) / 3600.0  # degrees
                tile_fov_hints.append(tile_fov)

                # 中心からの距離に応じた動的マージン: 0.2（中心）〜0.5（コーナー）
                r_pixels = np.sqrt(
                    (tile_cx - image_center_x) ** 2 + (tile_cy - image_center_y) ** 2
                )
                r_ratio = r_pixels / max_r_pixels if max_r_pixels > 0 else 0
                tile_margin = 0.2 + 0.3 * r_ratio
                tile_scale_margins.append(tile_margin)

                logger.info(
                    f"Tile {region['index']}: effective_scale={effective_scale:.2f}\"/px "
                    f"(x{effective_scale/pixel_scale:.2f}), FOV={tile_fov:.1f}°, "
                    f"margin=±{tile_margin:.0%}"
                )
            else:
                tile_fov_hints.append(None)
                tile_scale_margins.append(0.2)

        # RA/DECヒント
        ra_hint = args.ra  # degrees (画像全体の中心)
        dec_hint = args.dec  # degrees (画像全体の中心)

        # タイルごとのRA/DECヒントを計算
        tile_ra_hints = []
        tile_dec_hints = []
        if ra_hint is not None and dec_hint is not None and pixel_scale:
            logger.info(
                f"Using RA/DEC hint for image center: RA={ra_hint:.2f}°, DEC={dec_hint:+.2f}°"
            )
            logger.info(
                f"Calculating per-tile RA/DEC hints using {projection} projection..."
            )

            for sf in split_files:
                offset_x, offset_y = calculate_tile_center_offset(
                    sf["region"], image_width, image_height
                )
                tile_ra, tile_dec = pixel_offset_to_radec(
                    ra_hint,
                    dec_hint,
                    pixel_scale,
                    offset_x,
                    offset_y,
                    projection=projection,
                )
                tile_ra_hints.append(tile_ra)
                tile_dec_hints.append(tile_dec)
                logger.info(
                    f"Tile {sf['region']['index']}: "
                    f"offset=({offset_x:.0f}, {offset_y:.0f})px, "
                    f"hint=RA={tile_ra:.2f}° DEC={tile_dec:+.2f}°"
                )
        else:
            # RA/DECヒントなし
            tile_ra_hints = [None] * len(split_files)
            tile_dec_hints = [None] * len(split_files)

        # タイルごとに個別ソルブ（RA/DECの有無に関わらず統一ループ）
        from concurrent.futures import ThreadPoolExecutor, as_completed

        solve_results = {}
        with ThreadPoolExecutor(max_workers=4) as executor:
            future_to_tile = {}
            for i, sf in enumerate(split_files):
                future = executor.submit(
                    solver.solve_image,
                    sf["file_path"],
                    fov_hint=tile_fov_hints[i],
                    ra_hint=tile_ra_hints[i],
                    dec_hint=tile_dec_hints[i],
                    scale_margin=tile_scale_margins[i],
                )
                future_to_tile[future] = sf["file_path"]

            for future in as_completed(future_to_tile):
                path = future_to_tile[future]
                try:
                    result = future.result()
                    solve_results[str(path)] = result
                except Exception as e:
                    logger.error(f"Exception solving {path}: {e}")
                    solve_results[str(path)] = {
                        "success": False,
                        "wcs": None,
                        "error_message": str(e),
                        "file_path": path,
                        "solve_time": 0,
                    }

        # 成功数をカウント（1st pass）
        success_count = sum(1 for r in solve_results.values() if r["success"])
        logger.info(
            f"1st pass completed: {success_count}/{len(split_files)} tiles solved"
        )

        # 2パスソルブ: 成功タイルのWCSから正確なRA/DECヒントを計算して失敗タイルをリトライ
        failed_indices = [
            i
            for i, sf in enumerate(split_files)
            if not solve_results.get(str(sf["file_path"]), {}).get("success")
        ]

        if failed_indices and success_count > 0:
            logger.info(
                f"\n[Step 3b/6] 2nd pass: Retrying {len(failed_indices)} failed tiles "
                f"using WCS-derived hints from {success_count} solved tiles..."
            )

            # 成功タイルの参照情報を収集
            success_refs = []
            success_scales = []
            for i, sf in enumerate(split_files):
                result = solve_results.get(str(sf["file_path"]))
                if result and result["success"]:
                    region = sf["region"]
                    cx = (region["x_start"] + region["x_end"]) / 2.0
                    cy = (region["y_start"] + region["y_end"]) / 2.0
                    success_refs.append(
                        {
                            "index": i,
                            "cx": cx,
                            "cy": cy,
                            "wcs": result["wcs"],
                            "region": region,
                            "pixel_scale": result.get("pixel_scale"),
                        }
                    )
                    if result.get("pixel_scale"):
                        success_scales.append(result["pixel_scale"])

            # 成功タイルのスケール統計（偽陽性フィルタ用）
            if success_scales:
                median_scale = float(np.median(success_scales))
                scale_std = float(np.std(success_scales))
                logger.info(
                    f'1st pass scale stats: median={median_scale:.2f}"/px, '
                    f'std={scale_std:.2f}"/px, range={min(success_scales):.2f}-{max(success_scales):.2f}'
                )
            else:
                median_scale = None

            # 各失敗タイルに最も近い成功タイルのWCSで正確なRA/DECを計算してリトライ
            retry_futures = {}
            retry_hints = {}  # 偽陽性フィルタ用にヒントを保存
            with ThreadPoolExecutor(max_workers=4) as executor:
                for idx in failed_indices:
                    sf = split_files[idx]
                    region = sf["region"]
                    tile_cx = (region["x_start"] + region["x_end"]) / 2.0
                    tile_cy = (region["y_start"] + region["y_end"]) / 2.0

                    # 最も近い成功タイルを参照として選択
                    nearest = min(
                        success_refs,
                        key=lambda ref: np.sqrt(
                            (tile_cx - ref["cx"]) ** 2 + (tile_cy - ref["cy"]) ** 2
                        ),
                    )

                    ref_wcs = nearest["wcs"]
                    ref_region = nearest["region"]

                    # 失敗タイルの中心を参照タイルのローカル座標に変換
                    local_x = tile_cx - ref_region["x_start"]
                    local_y = tile_cy - ref_region["y_start"]

                    # 参照タイルのWCSで天球座標を取得
                    try:
                        tile_ra, tile_dec = ref_wcs.pixel_to_world_values(
                            local_x, local_y
                        )
                        tile_ra = float(tile_ra) % 360.0
                        tile_dec = float(tile_dec)
                    except Exception as e:
                        logger.warning(
                            f"Tile {region['index']}: "
                            f"WCS hint computation failed: {e}"
                        )
                        continue

                    ref_dist = np.sqrt(
                        (tile_cx - nearest["cx"]) ** 2 + (tile_cy - nearest["cy"]) ** 2
                    )

                    # タイル位置での推定スケールから FOV ヒントを計算
                    # 成功タイルのスケールを基に広めのマージンで制約
                    retry_fov = tile_fov_hints[idx] if tile_fov_hints[idx] else None
                    retry_margin = 0.5  # 2nd pass は ±50% の広めマージン

                    logger.info(
                        f"Tile {region['index']}: WCS hint "
                        f"RA={tile_ra:.2f}° DEC={tile_dec:+.2f}° "
                        f"(ref=tile {nearest['region']['index']}, "
                        f"dist={ref_dist:.0f}px), "
                        f"FOV hint={retry_fov:.1f}° ±{retry_margin:.0%}"
                        if retry_fov
                        else f"Tile {region['index']}: WCS hint "
                        f"RA={tile_ra:.2f}° DEC={tile_dec:+.2f}° "
                        f"(ref=tile {nearest['region']['index']}, "
                        f"dist={ref_dist:.0f}px), no FOV hint"
                    )

                    retry_hints[idx] = {
                        "ra": tile_ra,
                        "dec": tile_dec,
                        "fov": retry_fov,
                    }

                    # 2nd pass: スケール制約付き + 短タイムアウト
                    future = executor.submit(
                        solver.solve_image,
                        sf["file_path"],
                        fov_hint=retry_fov,
                        ra_hint=tile_ra,
                        dec_hint=tile_dec,
                        scale_margin=retry_margin,
                        timeout_override=180,  # 2nd pass は 180s
                    )
                    retry_futures[future] = (idx, sf["file_path"])

                # リトライ結果を収集（偽陽性フィルタ付き）
                retry_success = 0
                retry_rejected = 0
                for future in as_completed(retry_futures):
                    idx, path = retry_futures[future]
                    try:
                        result = future.result()
                        if result["success"]:
                            # 偽陽性フィルタ: スケールと座標の整合性チェック
                            hint = retry_hints.get(idx, {})
                            is_valid = True
                            reject_reason = ""

                            # スケール整合性: 成功タイルの中央値から大きく外れていないか
                            if median_scale and result.get("pixel_scale"):
                                scale_ratio = result["pixel_scale"] / median_scale
                                if scale_ratio < 0.3 or scale_ratio > 3.0:
                                    is_valid = False
                                    reject_reason = (
                                        f"scale={result['pixel_scale']:.2f}\"/px "
                                        f"(median={median_scale:.2f}, ratio={scale_ratio:.2f})"
                                    )

                            # 座標整合性: WCSヒントから大きく離れていないか
                            if is_valid and hint.get("ra") is not None:
                                ra_diff = abs(result["ra_center"] - hint["ra"])
                                if ra_diff > 180:
                                    ra_diff = 360 - ra_diff
                                dec_diff = abs(result["dec_center"] - hint["dec"])
                                coord_diff = np.sqrt(ra_diff**2 + dec_diff**2)
                                # search_radius の 1.5 倍を超えたら拒否
                                if (
                                    coord_diff
                                    > solver_config.get("search_radius", 10.0) * 1.5
                                ):
                                    is_valid = False
                                    reject_reason = (
                                        f"coord deviation={coord_diff:.1f}° "
                                        f"(hint RA={hint['ra']:.2f}° DEC={hint['dec']:+.2f}°, "
                                        f"result RA={result['ra_center']:.2f}° DEC={result['dec_center']:+.2f}°)"
                                    )

                            if is_valid:
                                solve_results[str(path)] = result
                                retry_success += 1
                                logger.info(
                                    f"2nd pass OK: tile "
                                    f"{split_files[idx]['region']['index']} "
                                    f"RA={result['ra_center']:.2f}° "
                                    f"DEC={result['dec_center']:+.2f}° "
                                    f"scale={result.get('pixel_scale', 0):.2f}\"/px"
                                )
                            else:
                                retry_rejected += 1
                                logger.warning(
                                    f"2nd pass REJECTED (false positive): tile "
                                    f"{split_files[idx]['region']['index']} — {reject_reason}"
                                )
                        else:
                            logger.debug(
                                f"2nd pass fail: tile "
                                f"{split_files[idx]['region']['index']}"
                            )
                    except Exception as e:
                        logger.error(
                            f"2nd pass error: tile "
                            f"{split_files[idx]['region']['index']}: {e}"
                        )

            logger.info(
                f"2nd pass: {retry_success}/{len(failed_indices)} additional tiles solved"
                + (
                    f" ({retry_rejected} false positives rejected)"
                    if retry_rejected
                    else ""
                )
            )

            # 成功数を再計算
            success_count = sum(1 for r in solve_results.values() if r["success"])
            logger.info(f"Total: {success_count}/{len(split_files)} tiles solved")

        if success_count == 0:
            logger.error("All tile solves failed")
            logger.error(
                f"Diagnostic info: projection={projection}, "
                f"pixel_scale={pixel_scale}, "
                f"ra_hint={ra_hint}, dec_hint={dec_hint}, "
                f"lens_type={lens_type}, grid={args.grid}"
            )
            # 最初のタイルの失敗理由を表示
            for sf in split_files[:3]:
                r = solve_results.get(str(sf["file_path"]), {})
                err = r.get("error_message", "unknown")
                logger.error(f"  Tile {sf['region']['index']}: {err[:200]}")
            if args.json_output:
                print(json.dumps({"success": False, "error": "All tile solves failed"}))
            return 1

        # Step 4: WCS情報を収集
        logger.info("\n[Step 4/6] Collecting WCS information...")
        split_wcs_list = []
        solve_results_list = []
        filtered_regions = []

        for sf in split_files:
            result = solve_results.get(str(sf["file_path"]))
            if result is None:
                logger.warning(f"No result for tile {sf['region']['index']}")
                continue
            if result["success"]:
                split_wcs_list.append(result["wcs"])
                solve_results_list.append(result)
                filtered_regions.append(sf["region"])
            else:
                logger.warning(
                    f"Skipping tile {sf['region']['index']}: "
                    f"{result.get('error_message', 'Unknown error')}"
                )

        logger.info(f"Collected WCS from {len(split_wcs_list)} tiles")

        # Step 5: WCS統合
        logger.info("\n[Step 5/6] Integrating WCS...")
        integrator = WCSIntegrator(
            original_image_shape=(image_data.shape[0], image_data.shape[1]),
            split_regions_info=filtered_regions,
            split_wcs_list=split_wcs_list,
            solve_results=solve_results_list,
        )

        # オーバーラップ検証
        validation_result = integrator.validate_overlap_consistency(
            tolerance_arcsec=args.overlap_tolerance
        )

        if not validation_result["consistent"]:
            logger.warning(
                f"Overlap validation failed: max error = {validation_result['max_error_arcsec']:.2f}\" "
                f'(tolerance = {args.overlap_tolerance}")'
            )
            logger.warning("Proceeding anyway, but results may be inaccurate")
        else:
            logger.info(
                f"Overlap validation passed: max error = {validation_result['max_error_arcsec']:.2f}\""
            )

        # WCS統合実行
        integrated_wcs = integrator.integrate_wcs(method=args.wcs_method)

        # Step 6: 元画像にWCS情報を書き込み
        logger.info("\n[Step 6/6] Writing WCS to output image...")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # 出力形式を判定（入力と同じ形式で出力）
        input_suffix = input_path.suffix.lower()
        output_suffix = output_path.suffix.lower()

        # 出力形式が指定されていない場合は入力と同じにする
        if output_suffix == "":
            output_path = output_path.with_suffix(input_suffix)
            output_suffix = input_suffix

        if output_suffix == ".xisf":
            # XISF形式で出力
            try:
                from xisf_handler import XISFHandler

                # 元画像を読み込み直してメタデータを取得
                _, metadata = XISFHandler.load_image(input_path)

                # WCS情報を追加して保存
                XISFHandler.save_image(
                    file_path=output_path,
                    image_data=image_data,
                    metadata=metadata,
                    wcs=integrated_wcs,
                )

                logger.info(f"WCS written to XISF: {output_path}")

            except ImportError as e:
                logger.error(f"XISF support not available: {e}")
                logger.error("Please install: pip install xisf lxml")
                return 1

        else:
            # FITS形式で出力
            FITSHandler.copy_with_wcs(
                input_path=input_path, output_path=output_path, wcs=integrated_wcs
            )

            logger.info(f"WCS written to FITS: {output_path}")

        logger.info("\n" + "=" * 60)
        logger.info("Split Image Solver - Completed Successfully")
        logger.info(f"Output: {output_path}")
        logger.info("=" * 60)

        # JSON出力モード（PixInsight連携用）
        if args.json_output or args.result_file:
            # 全WCSキーワードを取得（SIP係数含む）
            from xisf_handler import XISFHandler

            wcs_keywords = XISFHandler._wcs_to_fits_keywords(integrated_wcs)

            # タイル成否グリッドを生成
            grid_rows, grid_cols = _parse_grid(args.grid)
            tile_grid = _build_tile_grid(
                grid_rows, grid_cols, split_files, solve_results,
                skipped_indices=skipped_indices
            )

            # 機材情報
            equipment_info = {}
            if camera_info:
                equipment_info["camera"] = camera_info.get("display_name", "")
            if lens_info:
                equipment_info["lens"] = lens_info.get("display_name", "")
            if focal_length:
                equipment_info["focal_length_mm"] = focal_length
            if pixel_pitch:
                equipment_info["pixel_pitch_um"] = pixel_pitch
            if lens_type != "rectilinear":
                equipment_info["lens_type"] = lens_type
                equipment_info["projection"] = projection

            # 中心・四隅の座標を計算
            coordinates = {}
            try:
                w = image_width
                h = image_height
                # ピクセル座標 (0-indexed, FITS convention: pixel center)
                coord_points = {
                    "center": (w / 2.0, h / 2.0),
                    "top_left": (0.0, 0.0),
                    "top_right": (w - 1.0, 0.0),
                    "bottom_left": (0.0, h - 1.0),
                    "bottom_right": (w - 1.0, h - 1.0),
                }
                for label, (px, py) in coord_points.items():
                    ra, dec = integrated_wcs.pixel_to_world_values(px, py)
                    coordinates[label] = {
                        "ra_deg": float(ra),
                        "dec_deg": float(dec),
                    }
                # FOV 計算（対角）
                from astropy.coordinates import SkyCoord
                import astropy.units as u

                tl = coordinates["top_left"]
                br = coordinates["bottom_right"]
                tr = coordinates["top_right"]
                bl = coordinates["bottom_left"]
                c_tl = SkyCoord(ra=tl["ra_deg"] * u.deg, dec=tl["dec_deg"] * u.deg)
                c_br = SkyCoord(ra=br["ra_deg"] * u.deg, dec=br["dec_deg"] * u.deg)
                c_tr = SkyCoord(ra=tr["ra_deg"] * u.deg, dec=tr["dec_deg"] * u.deg)
                c_bl = SkyCoord(ra=bl["ra_deg"] * u.deg, dec=bl["dec_deg"] * u.deg)
                diag_fov1 = c_tl.separation(c_br).deg
                diag_fov2 = c_tr.separation(c_bl).deg
                coordinates["diagonal_fov_deg"] = float(max(diag_fov1, diag_fov2))
                # 横・縦 FOV
                c_center_top = SkyCoord(
                    ra=((tr["ra_deg"] + tl["ra_deg"]) / 2) * u.deg,
                    dec=((tr["dec_deg"] + tl["dec_deg"]) / 2) * u.deg,
                )
                c_center_bottom = SkyCoord(
                    ra=((br["ra_deg"] + bl["ra_deg"]) / 2) * u.deg,
                    dec=((br["dec_deg"] + bl["dec_deg"]) / 2) * u.deg,
                )
                coordinates["width_fov_deg"] = float(c_tl.separation(c_tr).deg)
                coordinates["height_fov_deg"] = float(
                    c_center_top.separation(c_center_bottom).deg
                )
            except Exception as e:
                logger.warning(f"座標計算エラー: {e}")

            json_result = {
                "success": True,
                "output_path": str(output_path),
                "tiles_solved": success_count,
                "tiles_total": len(split_files),
                "grid": {"rows": grid_rows, "cols": grid_cols},
                "tile_grid": tile_grid,
                "equipment": equipment_info,
                "coordinates": coordinates,
                "wcs": {
                    "crval1": float(integrated_wcs.wcs.crval[0]),
                    "crval2": float(integrated_wcs.wcs.crval[1]),
                    "pixel_scale": float(pixel_scale) if pixel_scale else None,
                },
                "wcs_keywords": wcs_keywords,
            }
            json_str = _json_dumps_pjsr_safe(json_result)
            if args.json_output:
                print(json_str)
                sys.stdout.flush()
            if args.result_file:
                with open(args.result_file, "w", encoding="utf-8") as rf:
                    rf.write(json_str)
                logger.info(f"Result JSON written to: {args.result_file}")

        return 0

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        json_result = {"success": False, "error": str(e)}
        json_str = json.dumps(json_result)
        if args.json_output:
            print(json_str)
            sys.stdout.flush()
        if args.result_file:
            try:
                with open(args.result_file, "w", encoding="utf-8") as rf:
                    rf.write(json_str)
            except Exception:
                pass
        return 1

    finally:
        # 一時ファイルのクリーンアップ
        if not args.keep_temp and temp_dir_obj:
            try:
                temp_dir_obj.cleanup()
                logger.info("Temporary files cleaned up")
            except Exception as e:
                logger.warning(f"Cleanup failed: {e}")
        elif args.keep_temp:
            logger.info(f"Temporary files kept at: {temp_dir_path}")


if __name__ == "__main__":
    sys.exit(main())
