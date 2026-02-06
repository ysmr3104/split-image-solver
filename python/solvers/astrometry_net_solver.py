"""
Astrometry.net オンラインAPIプレートソルバー
nova.astrometry.net APIを使用して超広角フィールドのプレートソルブに対応
"""

import os
import json
import time
import tempfile
from pathlib import Path
from typing import Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from solvers.base_solver import BasePlateSolver
from utils.logger import get_logger

logger = get_logger()

DEFAULT_BASE_URL = "http://nova.astrometry.net"
DEFAULT_TIMEOUT = 900  # 15 minutes
SUPPORTED_EXTENSIONS = {'.fits', '.fit', '.fts', '.png', '.jpg', '.jpeg', '.gif'}


class AstrometryNetSolver(BasePlateSolver):
    """
    Astrometry.net オンラインAPIプレートソルバー

    nova.astrometry.net APIを使用して画像のプレートソルブを実行する。
    超広角フィールド（35mm以下、>20 arcsec/pixel）に対応。
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT,
        **kwargs,
    ):
        """
        Args:
            api_key: Astrometry.net APIキー（Noneの場合は環境変数から取得）
            base_url: APIベースURL
            timeout: タイムアウト秒数（デフォルト900秒=15分）
        """
        self.api_key = api_key or os.environ.get("ASTROMETRY_NET_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session_key = None

        if not self.api_key:
            logger.warning(
                "No Astrometry.net API key provided. "
                "Set ASTROMETRY_NET_API_KEY environment variable or pass api_key parameter."
            )

        logger.info(f"AstrometryNetSolver initialized: base_url={self.base_url}, timeout={self.timeout}s")

    def _login(self):
        """APIにログインしてセッションキーを取得する"""
        url = f"{self.base_url}/api/login"
        payload = {"request-json": json.dumps({"apikey": self.api_key})}

        logger.info("Logging in to Astrometry.net API...")
        response = requests.post(url, data=payload)
        response.raise_for_status()

        result = response.json()
        if result.get("status") != "success":
            raise RuntimeError(f"Astrometry.net login failed: {result}")

        self.session_key = result["session"]
        logger.info("Astrometry.net login successful")

    def _upload_image(
        self,
        file_path: Path,
        scale_units: Optional[str] = None,
        scale_lower: Optional[float] = None,
        scale_upper: Optional[float] = None,
        center_ra: Optional[float] = None,
        center_dec: Optional[float] = None,
        radius: Optional[float] = None,
        downsample_factor: Optional[int] = None,
    ) -> int:
        """
        画像をアップロードしてsubmission IDを取得する

        Returns:
            int: submission ID
        """
        url = f"{self.base_url}/api/upload"

        upload_params = {
            "session": self.session_key,
            "allow_commercial_use": "n",
            "allow_modifications": "n",
            "publicly_visible": "n",
        }

        if scale_units:
            upload_params["scale_units"] = scale_units
        if scale_lower is not None:
            upload_params["scale_lower"] = scale_lower
        if scale_upper is not None:
            upload_params["scale_upper"] = scale_upper
        if center_ra is not None:
            upload_params["center_ra"] = center_ra
        if center_dec is not None:
            upload_params["center_dec"] = center_dec
        if radius is not None:
            upload_params["radius"] = radius
        if downsample_factor is not None:
            upload_params["downsample_factor"] = downsample_factor

        logger.info(f"Uploading image: {file_path}")

        with open(file_path, "rb") as f:
            files = {"file": (file_path.name, f, "application/octet-stream")}
            data = {"request-json": json.dumps(upload_params)}
            response = requests.post(url, files=files, data=data)

        response.raise_for_status()
        result = response.json()

        if result.get("status") != "success":
            raise RuntimeError(f"Image upload failed: {result}")

        subid = result["subid"]
        logger.info(f"Image uploaded successfully. Submission ID: {subid}")
        return subid

    def _wait_for_job(self, subid: int) -> int:
        """
        SubmissionのジョブIDを取得するまでポーリングする

        Args:
            subid: submission ID

        Returns:
            int: job ID

        Raises:
            TimeoutError: タイムアウト時
            RuntimeError: ジョブが見つからない場合
        """
        url = f"{self.base_url}/api/submissions/{subid}"
        start_time = time.time()
        poll_intervals = self._get_poll_intervals()

        logger.info(f"Waiting for submission {subid} to complete...")

        for interval in poll_intervals:
            if time.time() - start_time > self.timeout:
                raise TimeoutError(
                    f"Timed out after {self.timeout}s waiting for submission {subid}"
                )

            time.sleep(interval)

            response = requests.get(url)
            response.raise_for_status()
            result = response.json()

            jobs = result.get("jobs", [])
            if jobs and jobs[0] is not None:
                job_id = jobs[0]
                logger.info(f"Job ID obtained: {job_id}")
                return job_id

            elapsed = time.time() - start_time
            logger.debug(f"Submission {subid} still processing... ({elapsed:.0f}s elapsed)")

        raise TimeoutError(
            f"Timed out after {self.timeout}s waiting for submission {subid}"
        )

    def _wait_for_job_result(self, job_id: int) -> str:
        """
        ジョブの完了を待って結果ステータスを返す

        Args:
            job_id: job ID

        Returns:
            str: "success" or "failure"

        Raises:
            TimeoutError: タイムアウト時
        """
        url = f"{self.base_url}/api/jobs/{job_id}"
        start_time = time.time()
        poll_intervals = self._get_poll_intervals()

        logger.info(f"Waiting for job {job_id} to complete...")

        for interval in poll_intervals:
            if time.time() - start_time > self.timeout:
                raise TimeoutError(
                    f"Timed out after {self.timeout}s waiting for job {job_id}"
                )

            time.sleep(interval)

            response = requests.get(url)
            response.raise_for_status()
            result = response.json()

            status = result.get("status")
            if status in ("success", "failure"):
                logger.info(f"Job {job_id} completed with status: {status}")
                return status

            elapsed = time.time() - start_time
            logger.debug(f"Job {job_id} still processing... ({elapsed:.0f}s elapsed)")

        raise TimeoutError(
            f"Timed out after {self.timeout}s waiting for job {job_id}"
        )

    def _get_calibration(self, job_id: int) -> dict:
        """キャリブレーション結果を取得する"""
        url = f"{self.base_url}/api/jobs/{job_id}/calibration/"

        response = requests.get(url)
        response.raise_for_status()

        result = response.json()
        logger.info(
            f"Calibration: RA={result.get('ra'):.4f}°, Dec={result.get('dec'):.4f}°, "
            f"pixscale={result.get('pixscale'):.3f}\"/pix, "
            f"orientation={result.get('orientation'):.2f}°"
        )
        return result

    def _get_wcs_fits(self, job_id: int) -> fits.Header:
        """WCS FITS headerを取得する"""
        url = f"{self.base_url}/wcs_file/{job_id}"

        response = requests.get(url)
        response.raise_for_status()

        # レスポンスはFITSファイル
        with tempfile.NamedTemporaryFile(suffix=".fits", delete=False) as tmp:
            tmp.write(response.content)
            tmp_path = tmp.name

        try:
            with fits.open(tmp_path) as hdul:
                header = hdul[0].header.copy()
            return header
        finally:
            os.unlink(tmp_path)

    def _convert_xisf_to_fits(self, xisf_path: Path) -> Path:
        """
        XISFファイルを一時的なFITSファイルに変換する

        Args:
            xisf_path: XISFファイルパス

        Returns:
            Path: 一時FITSファイルパス（呼び出し側で削除すること）
        """
        from xisf_handler import XISFHandler

        logger.info(f"Converting XISF to FITS: {xisf_path}")
        image_data, metadata = XISFHandler.load_image(xisf_path)

        # 一時FITSファイルを作成
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".fits")
        os.close(tmp_fd)

        hdu = fits.PrimaryHDU(data=image_data)
        hdu.writeto(tmp_path, overwrite=True)

        logger.info(f"XISF converted to temporary FITS: {tmp_path}")
        return Path(tmp_path)

    def _get_poll_intervals(self):
        """
        プログレッシブポーリング間隔のジェネレーター
        5秒→10秒→15秒→30秒と徐々に延長
        """
        intervals = [5] * 6 + [10] * 6 + [15] * 4 + [30] * 100
        for interval in intervals:
            yield interval

    def solve_image(
        self,
        image_path,
        fov_hint=None,
        ra_hint=None,
        dec_hint=None,
    ) -> Dict:
        """
        単一画像のプレートソルブ

        Args:
            image_path: 画像ファイルパス
            fov_hint: 視野角ヒント（度）
            ra_hint: 赤経ヒント（度）
            dec_hint: 赤緯ヒント（度）

        Returns:
            Dict: ソルブ結果（BasePlateSolver形式に準拠）
        """
        image_path = Path(image_path)
        logger.info(f"Starting Astrometry.net solve for: {image_path}")
        start_time = time.time()

        if not image_path.exists():
            return {
                "success": False,
                "wcs": None,
                "error_message": f"File not found: {image_path}",
                "file_path": image_path,
                "solve_time": 0,
            }

        temp_fits_path = None
        try:
            # ログイン（セッション未取得の場合）
            if not self.session_key:
                self._login()

            # XISF → FITS変換（必要な場合）
            upload_path = image_path
            if image_path.suffix.lower() == ".xisf":
                temp_fits_path = self._convert_xisf_to_fits(image_path)
                upload_path = temp_fits_path

            # スケールヒントの構築
            scale_units = None
            scale_lower = None
            scale_upper = None
            if fov_hint:
                scale_units = "degwidth"
                scale_lower = fov_hint * 0.5
                scale_upper = fov_hint * 2.0

            # 画像アップロード
            subid = self._upload_image(
                file_path=upload_path,
                scale_units=scale_units,
                scale_lower=scale_lower,
                scale_upper=scale_upper,
                center_ra=ra_hint,
                center_dec=dec_hint,
                radius=10.0 if (ra_hint is not None and dec_hint is not None) else None,
            )

            # ジョブID取得を待機
            job_id = self._wait_for_job(subid)

            # ジョブ完了を待機
            status = self._wait_for_job_result(job_id)

            solve_time = time.time() - start_time

            if status != "success":
                logger.warning(f"Astrometry.net solve failed for {image_path}")
                return {
                    "success": False,
                    "wcs": None,
                    "error_message": "Astrometry.net solve failed (job status: failure)",
                    "file_path": image_path,
                    "solve_time": solve_time,
                }

            # キャリブレーション結果を取得
            calibration = self._get_calibration(job_id)

            # WCS FITSヘッダーを取得
            wcs_header = self._get_wcs_fits(job_id)
            wcs = WCS(wcs_header)

            ra_center = calibration.get("ra")
            dec_center = calibration.get("dec")
            pixel_scale = calibration.get("pixscale")
            orientation = calibration.get("orientation")

            # 元のファイルにWCS情報を書き込む
            self._write_wcs_to_file(image_path, wcs_header, wcs)

            logger.info(
                f"Astrometry.net solve successful: RA={ra_center:.4f}°, "
                f"Dec={dec_center:.4f}°, scale={pixel_scale:.3f}\"/pix, "
                f"time={solve_time:.1f}s"
            )

            return {
                "success": True,
                "wcs": wcs,
                "ra_center": float(ra_center),
                "dec_center": float(dec_center),
                "rotation": float(orientation) if orientation is not None else None,
                "pixel_scale": float(pixel_scale) if pixel_scale is not None else None,
                "solve_time": solve_time,
                "num_stars": None,
                "file_path": image_path,
            }

        except TimeoutError as e:
            logger.error(f"Astrometry.net timeout for {image_path}: {e}")
            return {
                "success": False,
                "wcs": None,
                "error_message": str(e),
                "file_path": image_path,
                "solve_time": time.time() - start_time,
            }

        except Exception as e:
            logger.error(f"Astrometry.net error for {image_path}: {e}")
            return {
                "success": False,
                "wcs": None,
                "error_message": str(e),
                "file_path": image_path,
                "solve_time": time.time() - start_time,
            }

        finally:
            # 一時FITSファイルのクリーンアップ
            if temp_fits_path and temp_fits_path.exists():
                temp_fits_path.unlink()

    def _write_wcs_to_file(self, image_path: Path, wcs_header: fits.Header, wcs: WCS):
        """
        元のファイルにWCS情報を書き込む

        Args:
            image_path: 元の画像ファイルパス
            wcs_header: WCS FITSヘッダー
            wcs: WCSオブジェクト
        """
        wcs_keywords = [
            "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2",
            "CD1_1", "CD1_2", "CD2_1", "CD2_2",
            "CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2",
            "RADESYS", "EQUINOX",
        ]

        if image_path.suffix.lower() == ".xisf":
            try:
                from xisf_handler import XISFHandler

                image_data, orig_metadata = XISFHandler.load_image(image_path)

                if "fits_keywords" not in orig_metadata:
                    orig_metadata["fits_keywords"] = {}

                for keyword in wcs_keywords:
                    if keyword in wcs_header:
                        orig_metadata["fits_keywords"][keyword] = wcs_header[keyword]

                orig_metadata["fits_keywords"]["PLTSOLVD"] = "T"

                XISFHandler.save_image(
                    file_path=image_path,
                    image_data=image_data,
                    metadata=orig_metadata,
                    wcs=wcs,
                )
                logger.info(f"WCS written to XISF file: {image_path}")
            except Exception as e:
                logger.warning(f"Failed to write WCS to XISF file: {e}")
        else:
            try:
                with fits.open(image_path, mode="update") as hdul:
                    for keyword in wcs_keywords:
                        if keyword in wcs_header:
                            hdul[0].header[keyword] = wcs_header[keyword]
                    hdul[0].header["PLTSOLVD"] = "T"
                logger.info(f"WCS written to FITS file: {image_path}")
            except Exception as e:
                logger.warning(f"Failed to write WCS to FITS file: {e}")

    def batch_solve(
        self,
        image_paths: List[Path],
        max_workers: int = 2,
        **solve_kwargs,
    ) -> Dict[str, Dict]:
        """
        複数画像を並列プレートソルブ

        注意: Astrometry.net APIにはレート制限があるため、
        max_workersはデフォルト2に制限。

        Args:
            image_paths: 画像ファイルパスリスト
            max_workers: 並列実行数（デフォルト2、API負荷軽減）
            **solve_kwargs: solve_image()に渡す追加引数

        Returns:
            Dict[str, Dict]: ファイルパスをキーとした結果辞書
        """
        logger.info(
            f"Starting batch Astrometry.net solve: {len(image_paths)} images, "
            f"{max_workers} workers"
        )

        results = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_path = {
                executor.submit(self.solve_image, path, **solve_kwargs): path
                for path in image_paths
            }

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

        success_count = sum(1 for r in results.values() if r["success"])
        logger.info(
            f"Batch solve completed: {success_count}/{len(image_paths)} successful"
        )

        return results
