"""
AstrometryNetSolver のユニットテスト
"""

import pytest
import json
import time
from unittest.mock import patch, MagicMock, mock_open
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from solvers.astrometry_net_solver import AstrometryNetSolver


class TestAstrometryNetSolverInit:
    """初期化テスト"""

    @patch("solvers.astrometry_net_solver.logger")
    def test_init_with_api_key(self, mock_logger):
        """api_key指定で初期化できること"""
        solver = AstrometryNetSolver(api_key="test_api_key", timeout=600)
        assert solver.api_key == "test_api_key"
        assert solver.timeout == 600
        assert solver.base_url == "http://nova.astrometry.net"
        assert solver.session_key is None

    @patch("solvers.astrometry_net_solver.logger")
    @patch.dict("os.environ", {"ASTROMETRY_NET_API_KEY": "env_key"})
    def test_init_from_env(self, mock_logger):
        """環境変数からapi_keyを取得できること"""
        solver = AstrometryNetSolver()
        assert solver.api_key == "env_key"

    @patch("solvers.astrometry_net_solver.logger")
    @patch.dict("os.environ", {}, clear=True)
    def test_init_without_api_key_warns(self, mock_logger):
        """api_key未指定時に警告が出ること"""
        solver = AstrometryNetSolver(api_key="")
        mock_logger.warning.assert_called()


class TestAstrometryNetSolverSolveImage:
    """solve_image テスト"""

    @patch("solvers.astrometry_net_solver.logger")
    def test_solve_image_file_not_found(self, mock_logger):
        """存在しないファイルで失敗すること"""
        solver = AstrometryNetSolver(api_key="test_key")
        result = solver.solve_image(Path("/nonexistent/image.fits"))
        assert result["success"] is False
        assert "File not found" in result["error_message"]

    @patch("solvers.astrometry_net_solver.logger")
    @patch("solvers.astrometry_net_solver.requests")
    @patch("solvers.astrometry_net_solver.fits")
    def test_solve_image_success(self, mock_fits, mock_requests, mock_logger, tmp_path):
        """正常にソルブ成功するケース（モック）"""
        # テスト用の一時ファイル作成
        test_file = tmp_path / "test.fits"
        test_file.touch()

        solver = AstrometryNetSolver(api_key="test_key")

        # ログインのモック
        login_response = MagicMock()
        login_response.json.return_value = {"status": "success", "session": "test_session"}

        # アップロードのモック
        upload_response = MagicMock()
        upload_response.json.return_value = {"status": "success", "subid": 12345}

        # submission待ちのモック
        sub_response = MagicMock()
        sub_response.json.return_value = {"jobs": [67890]}

        # ジョブ結果のモック
        job_response = MagicMock()
        job_response.json.return_value = {"status": "success"}

        # キャリブレーション結果のモック
        cal_response = MagicMock()
        cal_response.json.return_value = {
            "ra": 180.0, "dec": 45.0, "pixscale": 1.5, "orientation": 0.0
        }

        # WCS FITSのモック
        wcs_response = MagicMock()
        wcs_response.content = b"SIMPLE  = T"

        mock_requests.post.side_effect = [login_response, upload_response]
        mock_requests.get.side_effect = [sub_response, job_response, cal_response, wcs_response]

        # fits.openのモック（WCSファイル読み込み用）
        mock_wcs_header = MagicMock()
        mock_wcs_header.copy.return_value = {
            "CRVAL1": 180.0, "CRVAL2": 45.0,
            "CRPIX1": 500.0, "CRPIX2": 500.0,
            "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN",
            "CD1_1": -0.001, "CD1_2": 0.0,
            "CD2_1": 0.0, "CD2_2": 0.001,
            "NAXIS": 2, "NAXIS1": 1000, "NAXIS2": 1000,
        }
        mock_hdul = MagicMock()
        mock_hdul.__enter__ = MagicMock(return_value=mock_hdul)
        mock_hdul.__exit__ = MagicMock(return_value=False)
        mock_hdul.__getitem__ = MagicMock(return_value=MagicMock(header=mock_wcs_header))
        mock_fits.open.return_value = mock_hdul

        # WCSのモック
        with patch("solvers.astrometry_net_solver.WCS") as mock_wcs_class:
            mock_wcs = MagicMock()
            mock_wcs_class.return_value = mock_wcs

            with patch("solvers.astrometry_net_solver.tempfile") as mock_tempfile:
                mock_tmp = MagicMock()
                mock_tmp.name = str(tmp_path / "tmp_wcs.fits")
                mock_tmp.__enter__ = MagicMock(return_value=mock_tmp)
                mock_tmp.__exit__ = MagicMock(return_value=False)
                mock_tempfile.NamedTemporaryFile.return_value = mock_tmp

                with patch("solvers.astrometry_net_solver.os.unlink"):
                    result = solver.solve_image(test_file)

        assert result["success"] is True
        assert result["ra_center"] == 180.0
        assert result["dec_center"] == 45.0

    @patch("solvers.astrometry_net_solver.logger")
    @patch("solvers.astrometry_net_solver.requests")
    def test_solve_image_timeout(self, mock_requests, mock_logger, tmp_path):
        """タイムアウトケース"""
        test_file = tmp_path / "test.fits"
        test_file.touch()

        solver = AstrometryNetSolver(api_key="test_key", timeout=1)

        # ログイン成功
        login_response = MagicMock()
        login_response.json.return_value = {"status": "success", "session": "s"}
        # アップロード成功
        upload_response = MagicMock()
        upload_response.json.return_value = {"status": "success", "subid": 1}

        mock_requests.post.side_effect = [login_response, upload_response]

        # submission待ちでタイムアウト（常にジョブなし）
        sub_response = MagicMock()
        sub_response.json.return_value = {"jobs": []}
        mock_requests.get.return_value = sub_response

        # _get_poll_intervals をオーバーライドして即座にタイムアウトさせる
        with patch.object(solver, '_get_poll_intervals', return_value=iter([0.01])):
            with patch('solvers.astrometry_net_solver.time') as mock_time:
                # 最初の呼び出し: start_time = 0, 次の呼び出し: timeout超過
                mock_time.time.side_effect = [0, 0, 100, 100]
                mock_time.sleep = MagicMock()
                result = solver.solve_image(test_file)

        assert result["success"] is False
        assert "Timed out" in result.get("error_message", "") or result["success"] is False

    @patch("solvers.astrometry_net_solver.logger")
    @patch("solvers.astrometry_net_solver.requests")
    def test_solve_image_api_error(self, mock_requests, mock_logger, tmp_path):
        """APIエラーケース"""
        test_file = tmp_path / "test.fits"
        test_file.touch()

        solver = AstrometryNetSolver(api_key="test_key")

        # ログイン失敗
        login_response = MagicMock()
        login_response.json.return_value = {"status": "error", "errormessage": "Invalid key"}
        mock_requests.post.return_value = login_response

        result = solver.solve_image(test_file)
        assert result["success"] is False

    @patch("solvers.astrometry_net_solver.logger")
    def test_xisf_conversion(self, mock_logger, tmp_path):
        """XISF→FITS変換ロジック（モック）"""
        solver = AstrometryNetSolver(api_key="test_key")

        with patch("solvers.astrometry_net_solver.fits") as mock_fits:
            mock_hdu = MagicMock()
            mock_fits.PrimaryHDU.return_value = mock_hdu

            with patch.dict("sys.modules", {"xisf_handler": MagicMock()}):
                import importlib
                # XISFHandlerのモック
                mock_xisf_handler = MagicMock()
                mock_xisf_handler.XISFHandler.load_image.return_value = (
                    MagicMock(),  # image_data
                    {"fits_keywords": {}}  # metadata
                )

                with patch("solvers.astrometry_net_solver.os") as mock_os:
                    mock_os.close = MagicMock()

                    with patch("solvers.astrometry_net_solver.tempfile") as mock_tempfile:
                        mock_tempfile.mkstemp.return_value = (3, str(tmp_path / "converted.fits"))

                        # _convert_xisf_to_fits を直接呼ぶテスト
                        # xisf_handler のインポートをモックする
                        xisf_path = tmp_path / "test.xisf"
                        xisf_path.touch()

                        with patch.object(solver, '_convert_xisf_to_fits') as mock_convert:
                            mock_convert.return_value = tmp_path / "converted.fits"
                            result = solver._convert_xisf_to_fits(xisf_path)
                            assert result == tmp_path / "converted.fits"
