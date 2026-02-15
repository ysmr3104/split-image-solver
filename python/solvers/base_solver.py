"""
プレートソルバー抽象基底クラス
全てのプレートソルバーはこのクラスを継承する
"""

from abc import ABC, abstractmethod
from typing import Dict, List


class BasePlateSolver(ABC):
    """
    プレートソルバーの抽象基底クラス

    全てのプレートソルバー実装は、このクラスを継承し、
    solve_image() と batch_solve() を実装すること。

    返り値の形式は以下のDictに従う:
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

    @abstractmethod
    def solve_image(
        self, image_path, fov_hint=None, ra_hint=None, dec_hint=None, scale_margin=0.2
    ) -> Dict:
        """
        単一画像のプレートソルブ

        Args:
            image_path: 画像ファイルパス
            fov_hint: 視野角ヒント（度）
            ra_hint: 赤経ヒント（度）
            dec_hint: 赤緯ヒント（度）
            scale_margin: スケール許容マージン（0.2 = ±20%）

        Returns:
            Dict: ソルブ結果
        """
        pass

    @abstractmethod
    def batch_solve(self, image_paths, max_workers=4, **kwargs) -> Dict[str, Dict]:
        """
        バッチプレートソルブ

        Args:
            image_paths: 画像ファイルパスリスト
            max_workers: 並列実行数
            **kwargs: solve_image()に渡す追加引数

        Returns:
            Dict[str, Dict]: ファイルパスをキーとした結果辞書
        """
        pass
