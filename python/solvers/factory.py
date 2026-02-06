"""
ソルバーファクトリー
プレートソルバーインスタンスを生成する
"""

from solvers.base_solver import BasePlateSolver


def create_solver(**config) -> BasePlateSolver:
    """
    プレートソルバーインスタンスを生成する（astrometry_local固定）

    Args:
        **config: ソルバー固有の設定パラメータ

    Returns:
        BasePlateSolver: ソルバーインスタンス
    """
    from solvers.astrometry_local_solver import AstrometryLocalSolver
    return AstrometryLocalSolver(**config)
