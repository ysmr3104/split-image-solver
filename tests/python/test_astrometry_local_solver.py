"""
AstrometryLocalSolver のユニットテスト
"""

import pytest
from unittest.mock import patch, MagicMock, PropertyMock
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from solvers.astrometry_local_solver import AstrometryLocalSolver, find_solve_field


class TestFindSolveField:
    """find_solve_field() のテスト"""

    @patch("shutil.which", return_value="/usr/local/bin/solve-field")
    def test_find_via_which(self, mock_which):
        """shutil.whichで見つかるケース"""
        result = find_solve_field()
        assert result == Path("/usr/local/bin/solve-field")

    @patch("shutil.which", return_value=None)
    def test_find_not_found(self, mock_which):
        """どこにも見つからないケース"""
        with patch.object(Path, "exists", return_value=False):
            result = find_solve_field()
            assert result is None


class TestAstrometryLocalSolverInit:
    """AstrometryLocalSolver 初期化テスト"""

    @patch("solvers.astrometry_local_solver.logger")
    def test_init_with_solve_field(self, mock_logger, tmp_path):
        """solve-field パス指定で初期化できること"""
        solve_field = tmp_path / "solve-field"
        solve_field.touch()

        solver = AstrometryLocalSolver(
            solve_field_path=str(solve_field),
            timeout=300,
            search_radius=5.0
        )
        assert solver.solve_field_path == solve_field
        assert solver.timeout == 300
        assert solver.search_radius == 5.0

    @patch("solvers.astrometry_local_solver.logger")
    def test_init_without_solve_field_raises(self, mock_logger):
        """solve-field未検出でFileNotFoundErrorが発生すること"""
        with patch("solvers.astrometry_local_solver.find_solve_field", return_value=None):
            with pytest.raises(FileNotFoundError, match="solve-field command not found"):
                AstrometryLocalSolver()

    @patch("solvers.astrometry_local_solver.logger")
    def test_init_nonexistent_path_raises(self, mock_logger):
        """存在しないパス指定でFileNotFoundErrorが発生すること"""
        with pytest.raises(FileNotFoundError, match="solve-field executable not found"):
            AstrometryLocalSolver(solve_field_path="/nonexistent/solve-field")


class TestAstrometryLocalSolverSolveImage:
    """solve_image テスト"""

    @patch("solvers.astrometry_local_solver.logger")
    def test_solve_image_file_not_found(self, mock_logger, tmp_path):
        """存在しない画像ファイルで失敗すること"""
        solve_field = tmp_path / "solve-field"
        solve_field.touch()

        solver = AstrometryLocalSolver(solve_field_path=str(solve_field))
        result = solver.solve_image(Path("/nonexistent/image.fits"))
        assert result["success"] is False
        assert "File not found" in result["error_message"]

    @patch("solvers.astrometry_local_solver.logger")
    @patch("solvers.astrometry_local_solver.subprocess")
    @patch("solvers.astrometry_local_solver.fits")
    def test_solve_image_success(self, mock_fits, mock_subprocess, mock_logger, tmp_path):
        """正常にソルブ成功するケース（モック）"""
        # solve-field実行ファイル
        solve_field = tmp_path / "solve-field"
        solve_field.touch()

        # テスト画像ファイル
        test_file = tmp_path / "test.fits"
        test_file.touch()

        # .wcsファイル（成功判定用）
        wcs_file = tmp_path / "test.wcs"
        wcs_file.touch()

        solver = AstrometryLocalSolver(solve_field_path=str(solve_field))

        # subprocess.run のモック
        mock_result = MagicMock()
        mock_result.stdout = "Field solved."
        mock_result.stderr = ""
        mock_result.returncode = 0
        mock_subprocess.run.return_value = mock_result

        # fits.open のモック（.wcsファイル読み込み）
        mock_wcs_header = MagicMock()
        mock_wcs_header.__contains__ = lambda self, key: key in [
            "CD1_1", "CD1_2", "CD2_1", "CD2_2", "NAXIS1", "NAXIS2",
            "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CTYPE1", "CTYPE2"
        ]
        mock_wcs_header.__getitem__ = lambda self, key: {
            "CD1_1": -0.001, "CD1_2": 0.0, "CD2_1": 0.0, "CD2_2": 0.001,
            "NAXIS1": 1000, "NAXIS2": 1000,
            "CRVAL1": 180.0, "CRVAL2": 45.0,
            "CRPIX1": 500.0, "CRPIX2": 500.0,
            "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN",
        }[key]
        mock_wcs_header.get = lambda key, default=None: {
            "CD1_1": -0.001, "CD1_2": 0.0, "CD2_1": 0.0, "CD2_2": 0.001,
            "NAXIS1": 1000, "NAXIS2": 1000,
        }.get(key, default)

        mock_hdul_wcs = MagicMock()
        mock_hdul_wcs.__enter__ = MagicMock(return_value=mock_hdul_wcs)
        mock_hdul_wcs.__exit__ = MagicMock(return_value=False)
        mock_hdul_wcs.__getitem__ = MagicMock(return_value=MagicMock(header=mock_wcs_header))

        mock_orig_header = MagicMock()
        mock_orig_header.__getitem__ = lambda self, key: {"NAXIS1": 1000, "NAXIS2": 1000}[key]

        mock_hdul_orig = MagicMock()
        mock_hdul_orig.__enter__ = MagicMock(return_value=mock_hdul_orig)
        mock_hdul_orig.__exit__ = MagicMock(return_value=False)
        mock_hdul_orig.__getitem__ = MagicMock(return_value=MagicMock(header=mock_orig_header))

        mock_hdul_update = MagicMock()
        mock_hdul_update.__enter__ = MagicMock(return_value=mock_hdul_update)
        mock_hdul_update.__exit__ = MagicMock(return_value=False)
        mock_hdul_update.__getitem__ = MagicMock(return_value=MagicMock(header=MagicMock()))

        mock_fits.open.side_effect = [mock_hdul_wcs, mock_hdul_orig, mock_hdul_update]

        with patch("solvers.astrometry_local_solver.WCS") as mock_wcs_class:
            mock_wcs = MagicMock()
            mock_wcs.has_celestial = True
            mock_wcs.pixel_to_world_values.return_value = (180.0, 45.0)
            mock_wcs_class.return_value = mock_wcs

            result = solver.solve_image(test_file)

        assert result["success"] is True
        assert result["ra_center"] == 180.0
        assert result["dec_center"] == 45.0

    @patch("solvers.astrometry_local_solver.logger")
    @patch("solvers.astrometry_local_solver.subprocess")
    def test_solve_image_failure(self, mock_subprocess, mock_logger, tmp_path):
        """プレートソルブ失敗ケース"""
        solve_field = tmp_path / "solve-field"
        solve_field.touch()
        test_file = tmp_path / "test.fits"
        test_file.touch()
        # .wcsファイルは作らない（失敗を示す）

        solver = AstrometryLocalSolver(solve_field_path=str(solve_field))

        mock_result = MagicMock()
        mock_result.stdout = "No solution found."
        mock_result.stderr = "Failed"
        mock_result.returncode = 1
        mock_subprocess.run.return_value = mock_result

        result = solver.solve_image(test_file)
        assert result["success"] is False
        assert "solve-field failed" in result["error_message"]

    @patch("solvers.astrometry_local_solver.logger")
    @patch("solvers.astrometry_local_solver.subprocess")
    def test_solve_image_subprocess_timeout(self, mock_subprocess, mock_logger, tmp_path):
        """subprocessタイムアウトケース"""
        solve_field = tmp_path / "solve-field"
        solve_field.touch()
        test_file = tmp_path / "test.fits"
        test_file.touch()

        solver = AstrometryLocalSolver(solve_field_path=str(solve_field), timeout=10)

        import subprocess
        mock_subprocess.run.side_effect = subprocess.TimeoutExpired(cmd="solve-field", timeout=10)
        mock_subprocess.TimeoutExpired = subprocess.TimeoutExpired

        result = solver.solve_image(test_file)
        assert result["success"] is False
        assert "Timeout" in result["error_message"]


class TestCleanupTempFiles:
    """一時ファイル削除テスト"""

    @patch("solvers.astrometry_local_solver.logger")
    def test_cleanup_temp_files(self, mock_logger, tmp_path):
        """一時ファイルが正しく削除されること"""
        solve_field = tmp_path / "solve-field"
        solve_field.touch()

        solver = AstrometryLocalSolver(solve_field_path=str(solve_field))

        base_path = tmp_path / "test.fits"
        base_path.touch()

        # solve-fieldが生成する一時ファイルを作成
        temp_extensions = ['.wcs', '.solved', '.axy', '.corr', '.match',
                          '.rdls', '.xyls', '-indx.xyls', '.new']
        created_files = []
        for ext in temp_extensions:
            temp_file = tmp_path / f"test{ext}"
            temp_file.touch()
            created_files.append(temp_file)

        # クリーンアップ実行
        solver._cleanup_temp_files(base_path)

        # 全一時ファイルが削除されたことを確認
        for f in created_files:
            assert not f.exists(), f"{f} should have been deleted"
