#!/usr/bin/env python3
"""
Split Image Solver - メインスクリプト
広角星空画像を分割してプレートソルブし、統合したWCS情報を元画像に書き込む
"""

import argparse
import json
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


def main():
    """メインエントリーポイント"""
    parser = argparse.ArgumentParser(
        description="Split Image Solver - 広角星空画像の分割プレートソルブ"
    )

    # 必須引数
    parser.add_argument(
        "--input", type=str, required=True, help="入力FITS/XISF画像パス"
    )
    parser.add_argument(
        "--output", type=str, required=True, help="出力FITS/XISF画像パス"
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

    # ログ設定
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="ログレベル [デフォルト: INFO]",
    )
    parser.add_argument("--log-file", type=str, help="ログファイルパス")

    # 出力形式
    parser.add_argument(
        "--json-output",
        action="store_true",
        help="結果をJSON形式で標準出力に出力（PixInsight連携用）",
    )

    # 設定ファイル
    parser.add_argument(
        "--config", type=str, default="./config/settings.json", help="設定ファイルパス"
    )

    args = parser.parse_args()

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

        # Step 3: 各分割画像をプレートソルブ
        logger.info(f"\n[Step 3/6] Plate solving tiles with astrometry_local...")
        solver = create_solver(**solver_config)

        # 焦点距離とピクセルスケールから視野角を推定
        pixel_scale = args.pixel_scale  # arcsec/pixel（画像中心でのスケール）
        focal_length = args.focal_length  # mm
        pixel_pitch = args.pixel_pitch  # μm

        # コマンドライン引数が指定されていない場合、ヘッダーから取得を試みる
        if not focal_length:
            focal_length_raw = original_header.get("FOCALLEN")
            if focal_length_raw:
                if isinstance(focal_length_raw, (int, float, str)):
                    focal_length = float(focal_length_raw)
                elif isinstance(focal_length_raw, list) and len(focal_length_raw) > 0:
                    if (
                        isinstance(focal_length_raw[0], dict)
                        and "value" in focal_length_raw[0]
                    ):
                        focal_length = float(focal_length_raw[0]["value"])

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
                    pixel_scale, tile_cx, tile_cy, image_center_x, image_center_y
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
                "Calculating per-tile RA/DEC hints using gnomonic projection..."
            )

            for sf in split_files:
                offset_x, offset_y = calculate_tile_center_offset(
                    sf["region"], image_width, image_height
                )
                tile_ra, tile_dec = pixel_offset_to_radec(
                    ra_hint, dec_hint, pixel_scale, offset_x, offset_y
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

        # 成功数をカウント
        success_count = sum(1 for r in solve_results.values() if r["success"])
        logger.info(
            f"Plate solving completed: {success_count}/{len(split_files)} successful"
        )

        if success_count == 0:
            logger.error("All tile solves failed")
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
        if args.json_output:
            # 全WCSキーワードを取得（SIP係数含む）
            from xisf_handler import XISFHandler

            wcs_keywords = XISFHandler._wcs_to_fits_keywords(integrated_wcs)

            json_result = {
                "success": True,
                "output_path": str(output_path),
                "tiles_solved": success_count,
                "tiles_total": len(split_files),
                "wcs": {
                    "crval1": float(integrated_wcs.wcs.crval[0]),
                    "crval2": float(integrated_wcs.wcs.crval[1]),
                    "pixel_scale": float(pixel_scale) if pixel_scale else None,
                },
                "wcs_keywords": wcs_keywords,
            }
            print(json.dumps(json_result))

        return 0

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        if args.json_output:
            json_result = {"success": False, "error": str(e)}
            print(json.dumps(json_result))
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
