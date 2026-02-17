"""
Astrometry.net ローカル版プレートソルバー統合モジュール
ローカルにインストールされたsolve-fieldコマンドを呼び出してプレートソルブを実行
"""

import subprocess
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from astropy.io import fits
from astropy.wcs import WCS

from solvers.base_solver import BasePlateSolver
from utils.logger import get_logger

logger = get_logger()


def find_solve_field() -> Optional[Path]:
    """
    solve-fieldコマンドのパスを自動検出

    Returns:
        Path: solve-fieldコマンドのパス（見つからない場合はNone）
    """
    # 1. shutil.which で検索（PATHから自動検出）
    which_result = shutil.which("solve-field")
    if which_result:
        return Path(which_result)

    # 2. macOS Homebrew の標準パス
    homebrew_paths = [
        Path("/opt/homebrew/bin/solve-field"),  # Apple Silicon
        Path("/usr/local/bin/solve-field"),  # Intel Mac
    ]
    for path in homebrew_paths:
        if path.exists():
            return path

    # 3. Linux の標準パス
    linux_paths = [
        Path("/usr/bin/solve-field"),
        Path("/usr/local/bin/solve-field"),
        Path("/usr/local/astrometry/bin/solve-field"),
    ]
    for path in linux_paths:
        if path.exists():
            return path

    return None


class AstrometryLocalSolver(BasePlateSolver):
    """
    Astrometry.net ローカル版コマンドラインインターフェース

    solve-field呼び出し例:
    solve-field --overwrite --no-plots --scale-low 30 --scale-high 40 input.fits
    """

    def __init__(
        self,
        solve_field_path: Optional[str] = None,
        timeout: int = 300,
        search_radius: float = 10.0,
    ):
        """
        Args:
            solve_field_path: solve-fieldコマンドパス（Noneの場合は自動検出）
            timeout: タイムアウト秒数
            search_radius: 検索半径（度）- RA/DECヒント使用時の検索範囲
        """
        # solve-fieldコマンドのパスを決定
        if solve_field_path:
            self.solve_field_path = Path(solve_field_path)
        else:
            detected_path = find_solve_field()
            if detected_path is None:
                raise FileNotFoundError(
                    "solve-field command not found. "
                    "Please install Astrometry.net or specify solve_field_path."
                )
            self.solve_field_path = detected_path

        # 存在確認
        if not self.solve_field_path.exists():
            raise FileNotFoundError(
                f"solve-field executable not found: {self.solve_field_path}. "
                "Please install Astrometry.net or update the path in settings."
            )

        self.timeout = timeout
        self.search_radius = search_radius

        logger.info(f"AstrometryLocalSolver initialized: {self.solve_field_path}")

    def _convert_xisf_to_fits(self, xisf_path: Path) -> Path:
        """
        XISFファイルを一時FITSファイルに変換
        RGB画像はルミナンスに変換し、16bit整数にスケーリングする

        Args:
            xisf_path: XISFファイルパス

        Returns:
            Path: 一時FITSファイルパス
        """
        try:
            import numpy as np
            from xisf_handler import XISFHandler

            # XISFファイルを読み込む
            image_data, metadata = XISFHandler.load_image(xisf_path)

            # RGB画像の場合はルミナンスに変換（solve-fieldは2D画像が最適）
            if len(image_data.shape) == 3 and image_data.shape[2] == 3:
                image_data = (
                    0.2126 * image_data[:, :, 0]
                    + 0.7152 * image_data[:, :, 1]
                    + 0.0722 * image_data[:, :, 2]
                )
                logger.debug(f"Converted RGB to luminance: {image_data.shape}")

            # float32データを16bit unsigned integerにスケーリング
            # solve-fieldのsimplexyz source extractorはinteger画像で安定動作する
            if image_data.dtype in (np.float32, np.float64):
                vmin = np.percentile(image_data, 0.5)
                vmax = np.percentile(image_data, 99.9)
                if vmax > vmin:
                    scaled = np.clip((image_data - vmin) / (vmax - vmin), 0, 1)
                    image_data = (scaled * 65535).astype(np.uint16)
                else:
                    image_data = (image_data * 65535).astype(np.uint16)
                logger.debug(
                    f"Scaled to uint16: min={image_data.min()}, max={image_data.max()}"
                )

            # 一時FITSファイルパスを生成
            temp_fits_path = (
                xisf_path.parent / f"{xisf_path.stem}_temp_for_astrometry.fits"
            )

            # FITSファイルとして保存
            hdu = fits.PrimaryHDU(data=image_data)

            # メタデータからFITSキーワードをコピー
            if "fits_keywords" in metadata:
                for key, value in metadata["fits_keywords"].items():
                    try:
                        hdu.header[key] = value
                    except Exception as e:
                        logger.debug(f"Could not copy FITS keyword {key}: {e}")

            hdu.writeto(temp_fits_path, overwrite=True)
            logger.debug(f"Converted XISF to temporary FITS: {temp_fits_path}")

            return temp_fits_path

        except ImportError:
            logger.error("XISF support not available")
            raise
        except Exception as e:
            logger.error(f"Failed to convert XISF to FITS: {e}")
            raise

    def _cleanup_temp_files(self, base_path: Path):
        """
        solve-fieldが生成する一時ファイルをクリーンアップ

        Args:
            base_path: 入力ファイルのベースパス
        """
        # solve-fieldが生成する拡張子リスト
        temp_extensions = [
            ".wcs",
            ".solved",
            ".axy",
            ".corr",
            ".match",
            ".rdls",
            ".xyls",
            "-indx.xyls",
            ".new",
        ]

        for ext in temp_extensions:
            temp_file = base_path.parent / f"{base_path.stem}{ext}"
            if temp_file.exists():
                try:
                    temp_file.unlink()
                    logger.debug(f"Cleaned up: {temp_file}")
                except Exception as e:
                    logger.warning(f"Failed to clean up {temp_file}: {e}")

    def solve_image(
        self,
        image_path: Path,
        fov_hint: Optional[float] = None,
        ra_hint: Optional[float] = None,
        dec_hint: Optional[float] = None,
        scale_margin: float = 0.2,
        timeout_override: Optional[int] = None,
        tweak_order: int = 4,
    ) -> Dict:
        """
        単一画像をプレートソルブ

        Args:
            image_path: 画像ファイルパス（FITS or XISF）
            fov_hint: 視野角ヒント（度）
            ra_hint: 赤経ヒント（度）
            dec_hint: 赤緯ヒント（度）

        Returns:
            Dict:
                {
                    'success': bool,
                    'wcs': WCS object (astropy.wcs.WCS) or None,
                    'ra_center': float or None,
                    'dec_center': float or None,
                    'rotation': float or None,
                    'pixel_scale': float or None (arcsec/pixel),
                    'solve_time': float,
                    'num_stars': int or None,
                    'error_message': str (失敗時),
                    'file_path': Path
                }
        """
        image_path = Path(image_path)
        logger.info(f"Starting Astrometry.net local solve for: {image_path}")

        if not image_path.exists():
            return {
                "success": False,
                "wcs": None,
                "error_message": f"File not found: {image_path}",
                "file_path": image_path,
                "solve_time": 0,
            }

        # XISF形式の場合、一時FITSに変換
        is_xisf = image_path.suffix.lower() == ".xisf"
        if is_xisf:
            try:
                work_path = self._convert_xisf_to_fits(image_path)
            except Exception as e:
                return {
                    "success": False,
                    "wcs": None,
                    "error_message": f"XISF to FITS conversion failed: {str(e)}",
                    "file_path": image_path,
                    "solve_time": 0,
                }
        else:
            work_path = image_path

        # タイムアウト決定
        effective_timeout = timeout_override if timeout_override else self.timeout

        try:
            # solve-fieldコマンドライン引数を構築
            cmd = [
                str(self.solve_field_path),
                "--overwrite",  # 既存出力を上書き
                "--no-plots",  # プロットファイル不要
                "--no-remove-lines",  # 直線除去しない
                "--no-verify-uniformize",  # 高速化
                "--crpix-center",  # 歪みの基準点を画像中心に固定
                "--tweak-order",
                str(tweak_order),  # SIP多項式次数
                str(work_path),
            ]

            # 画像サイズを取得（FOVヒント・ダウンサンプルの両方で使用）
            with fits.open(work_path) as hdul:
                header = hdul[0].header
                width = header["NAXIS1"]
                height = header["NAXIS2"]
                max_dimension = max(width, height)

            # 大サイズタイルの自動ダウンサンプル
            if max_dimension > 2000:
                import math

                downsample = max(2, math.ceil(max_dimension / 2000))
                cmd.extend(["--downsample", str(downsample)])
                logger.debug(
                    f"Auto-downsample: {max_dimension}px -> factor {downsample}"
                )

            # FOVヒントがある場合、スケール範囲を指定
            if fov_hint:
                # arcsec/pixel を計算（FOV[deg] * 3600 / dimension[pixels]）
                scale_center = fov_hint * 3600 / max_dimension
                scale_low = scale_center * (1.0 - scale_margin)
                scale_high = scale_center * (1.0 + scale_margin)

                cmd.extend(["--scale-low", str(scale_low)])
                cmd.extend(["--scale-high", str(scale_high)])
                cmd.extend(["--scale-units", "arcsecperpix"])

            # RA/DECヒントがある場合
            if ra_hint is not None and dec_hint is not None:
                cmd.extend(["--ra", str(ra_hint)])
                cmd.extend(["--dec", str(dec_hint)])
                cmd.extend(["--radius", str(self.search_radius)])

            # タイムアウト設定（solve-fieldの--cpulimitオプション）
            cmd.extend(["--cpulimit", str(effective_timeout)])

            logger.debug(f"solve-field command: {' '.join(cmd)}")

            # solve-field実行
            start_time = time.time()
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=effective_timeout
                + 10,  # プロセス全体のタイムアウト（cpulimit + 余裕）
            )
            solve_time = time.time() - start_time

            logger.debug(f"solve-field stdout: {result.stdout}")
            if result.stderr:
                logger.debug(f"solve-field stderr: {result.stderr}")

            # 成功判定（solve-fieldは成功時に.wcsファイルを生成）
            wcs_file = work_path.parent / f"{work_path.stem}.wcs"

            if wcs_file.exists():
                try:
                    # .wcsファイル（FITSヘッダー形式）からWCS情報を読み取る
                    with fits.open(wcs_file) as wcs_hdul:
                        wcs_header = wcs_hdul[0].header

                    # NAXIS情報を設定（画像サイズは上で取得済み）
                    wcs_header["NAXIS1"] = width
                    wcs_header["NAXIS2"] = height

                    wcs = WCS(wcs_header)

                    # WCS情報が有効か確認
                    if not wcs.has_celestial:
                        raise ValueError("WCS has no celestial coordinates")

                    # 中心座標を取得
                    center_pixel = [
                        wcs_header["NAXIS1"] / 2.0,
                        wcs_header["NAXIS2"] / 2.0,
                    ]
                    ra_center, dec_center = wcs.pixel_to_world_values(
                        center_pixel[0], center_pixel[1]
                    )

                    # ピクセルスケールを計算（CD行列から）
                    if "CD1_1" in wcs_header and "CD2_2" in wcs_header:
                        import numpy as np

                        cd1_1 = wcs_header["CD1_1"]
                        cd1_2 = wcs_header.get("CD1_2", 0.0)
                        cd2_1 = wcs_header.get("CD2_1", 0.0)
                        cd2_2 = wcs_header["CD2_2"]

                        # ピクセルスケール (degree/pixel)
                        pixel_scale_deg = np.sqrt(abs(cd1_1 * cd2_2 - cd1_2 * cd2_1))
                        pixel_scale = pixel_scale_deg * 3600.0  # arcsec/pixel

                        # 回転角
                        rotation = np.degrees(np.arctan2(-cd1_2, cd1_1))
                    else:
                        pixel_scale = None
                        rotation = None

                    # 元のファイルにWCS情報を保存
                    if is_xisf:
                        # XISFファイルの場合
                        from xisf_handler import XISFHandler

                        image_data, orig_metadata = XISFHandler.load_image(image_path)

                        # WCS情報をFITSキーワードに追加
                        if "fits_keywords" not in orig_metadata:
                            orig_metadata["fits_keywords"] = {}

                        wcs_keywords = [
                            "CRVAL1",
                            "CRVAL2",
                            "CRPIX1",
                            "CRPIX2",
                            "CD1_1",
                            "CD1_2",
                            "CD2_1",
                            "CD2_2",
                            "CTYPE1",
                            "CTYPE2",
                            "CUNIT1",
                            "CUNIT2",
                            "RADESYS",
                            "EQUINOX",
                        ]
                        for keyword in wcs_keywords:
                            if keyword in wcs_header:
                                orig_metadata["fits_keywords"][keyword] = wcs_header[
                                    keyword
                                ]

                        # WCS情報を含めてXISFファイルを再保存
                        XISFHandler.save_image(
                            file_path=image_path,
                            image_data=image_data,
                            metadata=orig_metadata,
                            wcs=wcs,
                        )
                    else:
                        # FITSファイルの場合
                        with fits.open(image_path, mode="update") as orig_hdul:
                            # WCS関連のキーワードをコピー
                            wcs_keywords = [
                                "CRVAL1",
                                "CRVAL2",
                                "CRPIX1",
                                "CRPIX2",
                                "CD1_1",
                                "CD1_2",
                                "CD2_1",
                                "CD2_2",
                                "CTYPE1",
                                "CTYPE2",
                                "CUNIT1",
                                "CUNIT2",
                                "RADESYS",
                                "EQUINOX",
                            ]
                            for keyword in wcs_keywords:
                                if keyword in wcs_header:
                                    orig_hdul[0].header[keyword] = wcs_header[keyword]

                    # 成功ログと結果を返す
                    logger.info(
                        f"Astrometry.net local solve successful: RA={ra_center:.4f}°, "
                        f"Dec={dec_center:.4f}°, "
                        f'scale={pixel_scale:.2f}"/pix, '
                        f"time={solve_time:.1f}s"
                    )

                    return {
                        "success": True,
                        "wcs": wcs,
                        "ra_center": ra_center,
                        "dec_center": dec_center,
                        "rotation": rotation,
                        "pixel_scale": pixel_scale,
                        "solve_time": solve_time,
                        "num_stars": None,  # solve-fieldは星数を返さない
                        "file_path": image_path,
                    }

                except Exception as e:
                    logger.error(f"Failed to read WCS from .wcs file: {e}")
                    return {
                        "success": False,
                        "wcs": None,
                        "error_message": f"WCS read error: {str(e)}",
                        "file_path": image_path,
                        "solve_time": solve_time,
                    }
            else:
                # .wcsファイルが存在しない = 失敗
                error_msg = "solve-field failed to produce .wcs file"
                if result.stderr:
                    error_msg += f": {result.stderr}"

                # 失敗時は診断情報をINFOレベルで出力
                logger.warning(
                    f"Astrometry.net local solve failed for {image_path.name} "
                    f"(time={solve_time:.1f}s)"
                )
                # stdoutの最後の5行を抽出して失敗原因を表示
                stdout_lines = (
                    result.stdout.strip().split("\n") if result.stdout else []
                )
                if stdout_lines:
                    tail = stdout_lines[-5:] if len(stdout_lines) > 5 else stdout_lines
                    logger.info(
                        f"  solve-field output (last {len(tail)} lines):\n"
                        + "\n".join(f"    {line}" for line in tail)
                    )

                return {
                    "success": False,
                    "wcs": None,
                    "error_message": error_msg,
                    "file_path": image_path,
                    "solve_time": solve_time,
                }

        except subprocess.TimeoutExpired:
            logger.error(
                f"solve-field timeout after {effective_timeout}s for {image_path}"
            )
            return {
                "success": False,
                "wcs": None,
                "error_message": f"Timeout after {effective_timeout} seconds",
                "file_path": image_path,
                "solve_time": effective_timeout,
            }

        except Exception as e:
            logger.error(f"solve-field error for {image_path}: {e}")
            return {
                "success": False,
                "wcs": None,
                "error_message": str(e),
                "file_path": image_path,
                "solve_time": 0,
            }

        finally:
            # 作業ファイルをクリーンアップ
            if is_xisf and work_path.exists():
                work_path.unlink()

            # solve-fieldが生成する一時ファイルをクリーンアップ
            self._cleanup_temp_files(work_path)

    def batch_solve(
        self, image_paths: List[Path], max_workers: int = 4, **solve_kwargs
    ) -> Dict[str, Dict]:
        """
        複数画像を並列プレートソルブ

        Args:
            image_paths: 画像ファイルパスリスト
            max_workers: 並列実行数
            **solve_kwargs: solve_image()に渡す追加引数

        Returns:
            Dict[str, Dict]: ファイルパスをキーとした結果辞書
        """
        logger.info(
            f"Starting batch Astrometry.net local solve: {len(image_paths)} images, "
            f"{max_workers} workers"
        )

        results = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # タスクを投入
            future_to_path = {
                executor.submit(self.solve_image, path, **solve_kwargs): path
                for path in image_paths
            }

            # 結果を収集
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    result = future.result()
                    results[str(path)] = result

                    if result["success"]:
                        logger.info(f"Completed: {path.name}")
                    else:
                        logger.warning(
                            f"Failed: {path.name} - {result.get('error_message', 'Unknown error')}"
                        )

                except Exception as e:
                    logger.error(f"Exception during solve of {path}: {e}")
                    results[str(path)] = {
                        "success": False,
                        "wcs": None,
                        "error_message": f"Exception: {str(e)}",
                        "file_path": path,
                        "solve_time": 0,
                    }

        # 成功数をカウント
        success_count = sum(1 for r in results.values() if r["success"])
        logger.info(
            f"Batch solve completed: {success_count}/{len(image_paths)} successful"
        )

        return results
