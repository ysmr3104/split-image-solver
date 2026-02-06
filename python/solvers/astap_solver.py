"""
ASTAPプレートソルバー統合モジュール
ASTAPをコマンドラインから呼び出してプレートソルブを実行
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


class ASTAPSolver(BasePlateSolver):
    """
    ASTAPコマンドラインインターフェース

    ASTAP呼び出し例:
    astap -f input.fits -r 5 -fov 20
    """

    def __init__(
        self,
        astap_executable_path: str,
        database_path: Optional[str] = None,
        timeout: int = 300,
        downsample: int = 1,
        search_radius: float = 10.0
    ):
        """
        Args:
            astap_executable_path: ASTAPバイナリパス
            database_path: 星データベースパス（オプション）
            timeout: タイムアウト秒数
            downsample: ダウンサンプル係数（高速化用）
            search_radius: 検索半径（度）- RA/DECヒント使用時の検索範囲
        """
        self.astap_path = Path(astap_executable_path)
        self.database_path = Path(database_path) if database_path else None
        self.timeout = timeout
        self.downsample = downsample
        self.search_radius = search_radius

        # ASTAPの存在確認
        if not self.astap_path.exists():
            raise FileNotFoundError(
                f"ASTAP executable not found: {self.astap_path}. "
                "Please install ASTAP or update the path in settings."
            )

        logger.info(f"ASTAPSolver initialized: {self.astap_path}")

    def _read_wcs_from_ini(self, ini_path: Path) -> fits.Header:
        """
        ASTAP .iniファイルからWCS情報を読み取りFITSヘッダーを作成
        """
        header = fits.Header()

        try:
            with open(ini_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if '=' in line:
                        key, value = line.split('=', 1)
                        key = key.strip()
                        value = value.strip()

                        # WCS関連のキーワードのみ抽出
                        if key in ['PLTSOLVD', 'CRPIX1', 'CRPIX2', 'CRVAL1', 'CRVAL2',
                                   'CDELT1', 'CDELT2', 'CROTA1', 'CROTA2',
                                   'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2']:
                            # 型変換
                            if key == 'PLTSOLVD':
                                header[key] = value  # 'T' or 'F'
                            else:
                                try:
                                    header[key] = float(value)
                                except ValueError:
                                    header[key] = value

            # ASTAPは常にTAN投影を使用
            if 'CTYPE1' not in header:
                header['CTYPE1'] = 'RA---TAN'
            if 'CTYPE2' not in header:
                header['CTYPE2'] = 'DEC--TAN'

            logger.debug(f"Read WCS from .ini file: {ini_path}")

        except Exception as e:
            logger.error(f"Failed to read .ini file {ini_path}: {e}")
            raise

        return header

    def solve_image(
        self,
        fits_path: Path,
        resolution_hint: Optional[float] = None,
        fov_hint: Optional[float] = None,
        ra_hint: Optional[float] = None,
        dec_hint: Optional[float] = None
    ) -> Dict:
        """
        単一画像をプレートソルブ

        Args:
            fits_path: FITSファイルパス
            resolution_hint: arcsec/pixel (Noneの場合はヘッダーから推定)
            fov_hint: degrees (Noneの場合は画像サイズから推定)
            ra_hint: Right Ascension in degrees
            dec_hint: Declination in degrees

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
        fits_path = Path(fits_path)
        logger.info(f"Starting ASTAP solve for: {fits_path}")

        if not fits_path.exists():
            return {
                'success': False,
                'wcs': None,
                'error_message': f"File not found: {fits_path}",
                'file_path': fits_path,
                'solve_time': 0
            }

        # ASTAPは入力ファイルを直接更新するため、コピーを作成
        # 拡張子を保持（XISFファイルの場合も対応）
        work_path = fits_path.parent / f"{fits_path.stem}_astap_work{fits_path.suffix}"
        shutil.copy(fits_path, work_path)

        try:
            # ASTAPコマンドライン引数を構築
            cmd = [str(self.astap_path), '-f', str(work_path)]

            if fov_hint:
                cmd.extend(['-fov', str(fov_hint)])

            if ra_hint is not None and dec_hint is not None:
                cmd.extend(['-ra', str(ra_hint)])
                # ASTAP uses SPD (South Pole Distance) = 90 + declination
                spd = 90.0 + dec_hint
                cmd.extend(['-spd', str(spd)])
                # RA/DECヒント使用時は検索半径を指定
                cmd.extend(['-r', str(self.search_radius)])

            if self.downsample > 1:
                cmd.extend(['-z', str(self.downsample)])

            if self.database_path:
                cmd.extend(['-d', str(self.database_path)])

            logger.debug(f"ASTAP command: {' '.join(cmd)}")

            # ASTAP実行
            start_time = time.time()
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )
            solve_time = time.time() - start_time

            logger.debug(f"ASTAP stdout: {result.stdout}")
            if result.stderr:
                logger.debug(f"ASTAP stderr: {result.stderr}")

            # 成功判定（ASTAPは成功時に出力ファイルを更新する）
            if result.returncode == 0:
                # 更新されたファイルからWCS情報を読み取る
                try:
                    # FITS/XISF両方に対応
                    if fits_path.suffix.lower() == '.xisf':
                        # XISFファイルの場合、ASTAPは.iniファイルにWCS情報を書き込む
                        ini_path = work_path.parent / f"{work_path.stem}.ini"
                        if not ini_path.exists():
                            raise FileNotFoundError(f"ASTAP .ini file not found: {ini_path}")

                        # .iniファイルからWCS情報を読み取る
                        header = self._read_wcs_from_ini(ini_path)

                        # 元のXISFファイルからメタデータを読み込んでNAXIS情報を取得
                        try:
                            from xisf_handler import XISFHandler
                            image_data, _ = XISFHandler.load_image(work_path)
                            header['NAXIS1'] = image_data.shape[1] if len(image_data.shape) >= 2 else image_data.shape[0]
                            header['NAXIS2'] = image_data.shape[0]
                        except ImportError:
                            logger.error("XISF support not available")
                            raise
                    else:
                        # FITSファイルの場合
                        with fits.open(work_path) as hdul:
                            header = hdul[0].header

                    wcs = WCS(header)

                    # WCS情報が有効か確認
                    if not wcs.has_celestial:
                        raise ValueError("WCS has no celestial coordinates")

                    # 中心座標を取得
                    center_pixel = [header['NAXIS1'] / 2.0, header['NAXIS2'] / 2.0]
                    ra_center, dec_center = wcs.pixel_to_world_values(
                        center_pixel[0], center_pixel[1]
                    )

                    # ピクセルスケールを計算（CD行列から）
                    if 'CD1_1' in header and 'CD2_2' in header:
                        import numpy as np
                        cd1_1 = header['CD1_1']
                        cd1_2 = header.get('CD1_2', 0.0)
                        cd2_1 = header.get('CD2_1', 0.0)
                        cd2_2 = header['CD2_2']

                        # ピクセルスケール (degree/pixel)
                        pixel_scale_deg = np.sqrt(abs(cd1_1 * cd2_2 - cd1_2 * cd2_1))
                        pixel_scale = pixel_scale_deg * 3600.0  # arcsec/pixel

                        # 回転角
                        rotation = np.degrees(np.arctan2(-cd1_2, cd1_1))
                    else:
                        pixel_scale = None
                        rotation = None

                    # 元のファイルにWCS情報をコピー
                    if fits_path.suffix.lower() == '.xisf':
                        # XISFファイルの場合、WCS情報をヘッダーから取得して保存
                        from xisf_handler import XISFHandler
                        image_data, orig_metadata = XISFHandler.load_image(fits_path)

                        # WCS情報をFITSキーワードに追加
                        if 'fits_keywords' not in orig_metadata:
                            orig_metadata['fits_keywords'] = {}

                        wcs_keywords = [
                            'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2',
                            'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2',
                            'CTYPE1', 'CTYPE2', 'CUNIT1', 'CUNIT2',
                            'RADESYS', 'EQUINOX', 'PLTSOLVD'
                        ]
                        for keyword in wcs_keywords:
                            if keyword in header:
                                # 単純な値として格納（_format_fits_keywords_for_xisfで変換される）
                                orig_metadata['fits_keywords'][keyword] = header[keyword]

                        # WCS情報を含めてXISFファイルを再保存
                        XISFHandler.save_image(
                            file_path=fits_path,
                            image_data=image_data,
                            metadata=orig_metadata,
                            wcs=wcs
                        )
                    else:
                        # FITSファイルの場合
                        with fits.open(fits_path, mode='update') as orig_hdul:
                            # WCS関連のキーワードをコピー
                            wcs_keywords = [
                                'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2',
                                'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2',
                                'CTYPE1', 'CTYPE2', 'CUNIT1', 'CUNIT2',
                                'RADESYS', 'EQUINOX'
                            ]
                            for keyword in wcs_keywords:
                                if keyword in header:
                                    orig_hdul[0].header[keyword] = header[keyword]

                            # ASTAP固有のキーワードもコピー
                            astap_keywords = ['PLTSOLVD', 'COMMENT', 'HISTORY']
                            for keyword in astap_keywords:
                                if keyword in header:
                                    if keyword in ['COMMENT', 'HISTORY']:
                                        for value in header.get(keyword, []):
                                            if 'ASTAP' in str(value):
                                                orig_hdul[0].header[keyword] = value
                                    else:
                                        orig_hdul[0].header[keyword] = header[keyword]

                    # 成功ログと結果を返す（FITS/XISF共通）
                    logger.info(
                        f"ASTAP solve successful: RA={ra_center:.4f}°, "
                        f"Dec={dec_center:.4f}°, "
                        f"scale={pixel_scale:.2f}\"/pix, "
                        f"time={solve_time:.1f}s"
                    )

                    return {
                        'success': True,
                        'wcs': wcs,
                        'ra_center': ra_center,
                        'dec_center': dec_center,
                        'rotation': rotation,
                        'pixel_scale': pixel_scale,
                        'solve_time': solve_time,
                        'num_stars': header.get('NSTARS', None),
                        'file_path': fits_path
                    }

                except Exception as e:
                    logger.error(f"Failed to read WCS from solved image: {e}")
                    return {
                        'success': False,
                        'wcs': None,
                        'error_message': f"WCS read error: {str(e)}",
                        'file_path': fits_path,
                        'solve_time': solve_time
                    }
            else:
                error_msg = f"ASTAP failed with return code {result.returncode}"
                if result.stderr:
                    error_msg += f": {result.stderr}"

                logger.warning(f"ASTAP solve failed for {fits_path}: {error_msg}")

                return {
                    'success': False,
                    'wcs': None,
                    'error_message': error_msg,
                    'file_path': fits_path,
                    'solve_time': solve_time
                }

        except subprocess.TimeoutExpired:
            logger.error(f"ASTAP timeout after {self.timeout}s for {fits_path}")
            return {
                'success': False,
                'wcs': None,
                'error_message': f"Timeout after {self.timeout} seconds",
                'file_path': fits_path,
                'solve_time': self.timeout
            }

        except Exception as e:
            logger.error(f"ASTAP error for {fits_path}: {e}")
            return {
                'success': False,
                'wcs': None,
                'error_message': str(e),
                'file_path': fits_path,
                'solve_time': 0
            }

        finally:
            # 作業ファイルをクリーンアップ
            if work_path.exists():
                work_path.unlink()
            # ASTAPが生成する追加ファイルもクリーンアップ
            for ext in ['.ini', '.wcs', '_wcs.fits']:
                temp_file = fits_path.parent / f"{fits_path.stem}{ext}"
                if temp_file.exists():
                    temp_file.unlink()

    def batch_solve(
        self,
        fits_paths: List[Path],
        max_workers: int = 4,
        **solve_kwargs
    ) -> Dict[str, Dict]:
        """
        複数画像を並列プレートソルブ

        Args:
            fits_paths: List[Path] FITSファイルパスリスト
            max_workers: 並列実行数
            **solve_kwargs: solve_image()に渡す追加引数

        Returns:
            Dict[str, Dict]: ファイルパスをキーとした結果辞書
        """
        logger.info(
            f"Starting batch ASTAP solve: {len(fits_paths)} images, "
            f"{max_workers} workers"
        )

        results = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # タスクを投入
            future_to_path = {
                executor.submit(self.solve_image, path, **solve_kwargs): path
                for path in fits_paths
            }

            # 結果を収集
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    result = future.result()
                    results[str(path)] = result

                    if result['success']:
                        logger.info(f"Completed: {path.name}")
                    else:
                        logger.warning(
                            f"Failed: {path.name} - {result.get('error_message', 'Unknown error')}"
                        )

                except Exception as e:
                    logger.error(f"Exception during solve of {path}: {e}")
                    results[str(path)] = {
                        'success': False,
                        'wcs': None,
                        'error_message': f"Exception: {str(e)}",
                        'file_path': path,
                        'solve_time': 0
                    }

        # 成功数をカウント
        success_count = sum(1 for r in results.values() if r['success'])
        logger.info(
            f"Batch solve completed: {success_count}/{len(fits_paths)} successful"
        )

        return results
