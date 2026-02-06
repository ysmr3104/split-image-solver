"""
ソルバーファクトリー
solver_typeに応じて適切なプレートソルバーインスタンスを生成する
"""

from solvers.base_solver import BasePlateSolver


def create_solver(solver_type: str, **config) -> BasePlateSolver:
    """
    プレートソルバーインスタンスを生成する

    Args:
        solver_type: ソルバー種別 ("astap", "astrometry", "astrometry_local")
        **config: ソルバー固有の設定パラメータ

    Returns:
        BasePlateSolver: ソルバーインスタンス

    Raises:
        ValueError: 未知のソルバー種別またはまだ実装されていないソルバー
    """
    if solver_type == "astap":
        from solvers.astap_solver import ASTAPSolver
        return ASTAPSolver(**config)
    elif solver_type == "astrometry":
        from solvers.astrometry_net_solver import AstrometryNetSolver
        return AstrometryNetSolver(**config)
    elif solver_type == "astrometry_local":
        from solvers.astrometry_local_solver import AstrometryLocalSolver
        return AstrometryLocalSolver(**config)
    else:
        raise ValueError(f"Unknown solver type: {solver_type}")
