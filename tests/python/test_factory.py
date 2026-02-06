"""
ソルバーファクトリーのユニットテスト
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


# テスト対象のモジュールをインポートするためにパスを追加
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from solvers.factory import create_solver
from solvers.base_solver import BasePlateSolver


class TestCreateSolver:
    """create_solver() のテスト"""

    @patch("solvers.astap_solver.ASTAPSolver.__init__", return_value=None)
    def test_create_astap_solver(self, mock_init):
        """astapソルバーが正しく作成されること"""
        solver = create_solver("astap", astap_executable_path="/usr/bin/astap")
        mock_init.assert_called_once_with(astap_executable_path="/usr/bin/astap")
        from solvers.astap_solver import ASTAPSolver
        assert isinstance(solver, ASTAPSolver)

    @patch("solvers.astrometry_net_solver.AstrometryNetSolver.__init__", return_value=None)
    def test_create_astrometry_solver(self, mock_init):
        """astrometryソルバーが正しく作成されること"""
        solver = create_solver("astrometry", api_key="test_key", timeout=600)
        mock_init.assert_called_once_with(api_key="test_key", timeout=600)
        from solvers.astrometry_net_solver import AstrometryNetSolver
        assert isinstance(solver, AstrometryNetSolver)

    @patch("solvers.astrometry_local_solver.AstrometryLocalSolver.__init__", return_value=None)
    def test_create_astrometry_local_solver(self, mock_init):
        """astrometry_localソルバーが正しく作成されること"""
        solver = create_solver("astrometry_local", solve_field_path="/usr/bin/solve-field")
        mock_init.assert_called_once_with(solve_field_path="/usr/bin/solve-field")
        from solvers.astrometry_local_solver import AstrometryLocalSolver
        assert isinstance(solver, AstrometryLocalSolver)

    def test_create_unknown_solver(self):
        """不明なsolver_typeでValueErrorが発生すること"""
        with pytest.raises(ValueError, match="Unknown solver type: invalid_solver"):
            create_solver("invalid_solver")

    def test_solver_inheritance(self):
        """全ソルバーがBasePlateSolverを継承していること"""
        from solvers.astap_solver import ASTAPSolver
        from solvers.astrometry_net_solver import AstrometryNetSolver
        from solvers.astrometry_local_solver import AstrometryLocalSolver

        assert issubclass(ASTAPSolver, BasePlateSolver)
        assert issubclass(AstrometryNetSolver, BasePlateSolver)
        assert issubclass(AstrometryLocalSolver, BasePlateSolver)
