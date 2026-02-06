"""
WCS座標統合モジュール
分割画像のWCS情報を統合して元画像のWCSを計算する
"""

import numpy as np
from typing import Dict, List, Tuple, Optional
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
import astropy.units as u
from scipy.optimize import least_squares

from utils.logger import get_logger

logger = get_logger()


class WCSIntegrator:
    """
    分割画像のWCS情報を統合して元画像のWCSを計算

    アルゴリズム:
    1. 各分割画像のWCS情報を元画像座標系に変換
    2. オーバーラップ領域での整合性検証
    3. 全分割画像のWCSから最適な元画像WCSを推定
    """

    def __init__(
        self,
        original_image_shape: Tuple[int, int],
        split_regions_info: List[Dict],
        split_wcs_list: List[WCS],
        solve_results: List[Dict]
    ):
        """
        Args:
            original_image_shape: (height, width) 元画像サイズ
            split_regions_info: List[Dict] 分割領域情報（ImageSplitterから）
            split_wcs_list: List[WCS] 各分割のWCS
            solve_results: List[Dict] ASTAPソルブ結果（品質情報含む）
        """
        self.original_height, self.original_width = original_image_shape
        self.split_regions = split_regions_info
        self.split_wcs_list = split_wcs_list
        self.solve_results = solve_results

        self.num_tiles = len(split_regions_info)

        logger.info(
            f"WCSIntegrator initialized: image={self.original_width}x{self.original_height}, "
            f"tiles={self.num_tiles}"
        )

    def transform_split_wcs_to_full_image(
        self,
        split_wcs: WCS,
        offset_x: int,
        offset_y: int
    ) -> WCS:
        """
        分割画像のWCSを元画像座標系に変換

        原理:
        - 分割画像のピクセル座標 (x_split, y_split)
        - 元画像内での座標 (x_full, y_full) = (x_split + offset_x, y_split + offset_y)
        - WCSのCRPIX (参照ピクセル座標) をオフセット分調整

        Args:
            split_wcs: astropy.wcs.WCS 分割画像のWCS
            offset_x, offset_y: 元画像内でのオフセット

        Returns:
            astropy.wcs.WCS: 元画像座標系に変換されたWCS
        """
        # 新しいWCSオブジェクトを作成（ディープコピー）
        full_wcs = split_wcs.deepcopy()

        # CRPIX (参照ピクセル座標) を調整
        # CRPIX は 1-based (FITS規約)
        full_wcs.wcs.crpix[0] += offset_x
        full_wcs.wcs.crpix[1] += offset_y

        # CD matrix, CDELT, rotation は変更不要
        # （スケールと回転は元画像と同じ）

        return full_wcs

    def validate_overlap_consistency(
        self,
        tolerance_arcsec: float = 5.0,
        sample_spacing: int = 20
    ) -> Dict:
        """
        オーバーラップ領域でのWCS整合性を検証

        方法:
        1. 隣接する分割画像ペアを特定
        2. オーバーラップ領域のピクセルをサンプリング
        3. 各WCSでピクセル→天球座標変換
        4. 座標差を計算（角距離）
        5. 許容値以内か確認

        Args:
            tolerance_arcsec: 許容誤差（秒角）
            sample_spacing: サンプリング間隔（ピクセル）

        Returns:
            Dict:
                {
                    'consistent': bool,
                    'max_error_arcsec': float,
                    'mean_error_arcsec': float,
                    'rms_error_arcsec': float,
                    'error_map': Dict[Tuple[int, int], float]
                }
        """
        logger.info("Validating WCS consistency in overlap regions...")

        adjacent_pairs = self._find_adjacent_pairs()
        errors = []
        error_map = {}

        for (i, j) in adjacent_pairs:
            region_i = self.split_regions[i]
            region_j = self.split_regions[j]
            wcs_i = self.split_wcs_list[i]
            wcs_j = self.split_wcs_list[j]

            # オーバーラップ領域を計算
            overlap_region = self._calculate_overlap_region(region_i, region_j)

            if overlap_region is None:
                continue

            # オーバーラップ領域内でピクセルをサンプリング
            test_pixels = self._generate_grid_in_region(
                overlap_region, spacing=sample_spacing
            )

            pair_errors = []

            for (x_full, y_full) in test_pixels:
                # 分割画像 i の局所座標に変換
                x_i = x_full - region_i['x_start']
                y_i = y_full - region_i['y_start']

                # 分割画像 j の局所座標に変換
                x_j = x_full - region_j['x_start']
                y_j = y_full - region_j['y_start']

                try:
                    # 各WCSで天球座標に変換
                    sky_i = wcs_i.pixel_to_world(x_i, y_i)
                    sky_j = wcs_j.pixel_to_world(x_j, y_j)

                    # 角距離を計算
                    angular_sep = sky_i.separation(sky_j).arcsec

                    errors.append(angular_sep)
                    pair_errors.append(angular_sep)

                except Exception as e:
                    logger.warning(
                        f"Failed to compute separation at ({x_full}, {y_full}): {e}"
                    )
                    continue

            if pair_errors:
                pair_mean_error = np.mean(pair_errors)
                error_map[(i, j)] = pair_mean_error
                logger.debug(
                    f"Overlap pair [{region_i['index']}]-[{region_j['index']}]: "
                    f"mean error = {pair_mean_error:.2f}\""
                )

        if not errors:
            logger.warning("No overlap regions found for validation")
            return {
                'consistent': True,
                'max_error_arcsec': 0.0,
                'mean_error_arcsec': 0.0,
                'rms_error_arcsec': 0.0,
                'error_map': {}
            }

        errors_array = np.array(errors)
        mean_error = np.mean(errors_array)
        max_error = np.max(errors_array)
        rms_error = np.sqrt(np.mean(errors_array ** 2))

        consistent = max_error < tolerance_arcsec

        logger.info(
            f"Overlap validation: mean={mean_error:.2f}\", "
            f"max={max_error:.2f}\", RMS={rms_error:.2f}\", "
            f"consistent={consistent}"
        )

        return {
            'consistent': consistent,
            'max_error_arcsec': float(max_error),
            'mean_error_arcsec': float(mean_error),
            'rms_error_arcsec': float(rms_error),
            'error_map': error_map
        }

    def integrate_wcs(
        self,
        method: str = 'weighted_least_squares',
        control_points_per_tile: int = 25
    ) -> WCS:
        """
        全分割画像のWCSを統合して元画像の最適WCSを計算

        Args:
            method: 'weighted_least_squares' or 'central_tile'
            control_points_per_tile: タイル当たりの制御点数

        Returns:
            astropy.wcs.WCS: 統合された元画像のWCS
        """
        logger.info(f"Integrating WCS using method: {method}")

        if method == 'weighted_least_squares':
            return self._integrate_wcs_weighted_least_squares(control_points_per_tile)
        elif method == 'central_tile':
            return self._integrate_wcs_central_tile()
        else:
            raise ValueError(f"Unknown integration method: {method}")

    def _integrate_wcs_weighted_least_squares(
        self,
        control_points_per_tile: int
    ) -> WCS:
        """
        重み付き最小二乗法によるWCS統合

        アルゴリズム:
        1. 各分割画像から制御点を抽出
        2. 全制御点から最適WCSパラメータを推定
        3. 重み付け: 中心に近いほど高重み、ソルブ品質による重み
        """
        logger.info("Collecting control points from all tiles...")

        control_points = []
        weights = []

        # 画像中心
        center_x = self.original_width / 2.0
        center_y = self.original_height / 2.0

        for idx, (region, wcs, result) in enumerate(
            zip(self.split_regions, self.split_wcs_list, self.solve_results)
        ):
            if not result['success']:
                logger.warning(f"Skipping tile {idx}: solve failed")
                continue

            # タイル内でグリッド点を生成
            tile_width = region['width']
            tile_height = region['height']

            grid_size = int(np.sqrt(control_points_per_tile))
            x_local = np.linspace(0, tile_width - 1, grid_size)
            y_local = np.linspace(0, tile_height - 1, grid_size)

            for xl in x_local:
                for yl in y_local:
                    try:
                        # 天球座標に変換
                        sky_coord = wcs.pixel_to_world(xl, yl)

                        # 元画像座標系での座標
                        x_full = xl + region['x_start']
                        y_full = yl + region['y_start']

                        # 重みを計算
                        # 1. 画像中心からの距離による重み
                        dist_from_center = np.sqrt(
                            (x_full - center_x) ** 2 + (y_full - center_y) ** 2
                        )
                        max_dist = np.sqrt(center_x ** 2 + center_y ** 2)
                        distance_weight = 1.0 - (dist_from_center / max_dist) * 0.5

                        # 2. ソルブ時間による品質重み（速い方が良い）
                        solve_time = result.get('solve_time', 60)
                        time_weight = min(1.0, 30.0 / max(solve_time, 1.0))

                        # 3. ピクセルスケールの信頼性（存在する場合）
                        scale_weight = 1.0 if result.get('pixel_scale') else 0.5

                        # 総合重み
                        total_weight = distance_weight * time_weight * scale_weight

                        control_points.append({
                            'x_full': x_full,
                            'y_full': y_full,
                            'ra': sky_coord.ra.degree,
                            'dec': sky_coord.dec.degree,
                            'weight': total_weight
                        })
                        weights.append(total_weight)

                    except Exception as e:
                        logger.debug(f"Failed to create control point at ({xl}, {yl}): {e}")
                        continue

        if not control_points:
            raise ValueError("No valid control points collected")

        logger.info(f"Collected {len(control_points)} control points")

        # WCSパラメータを最適化
        integrated_wcs = self._optimize_wcs_parameters(
            control_points, weights, center_x, center_y
        )

        return integrated_wcs

    def _optimize_wcs_parameters(
        self,
        control_points: List[Dict],
        weights: List[float],
        center_x: float,
        center_y: float
    ) -> WCS:
        """
        制御点からWCSパラメータを最適化

        最小化する目的関数:
        Σ weight_i * ||projected(x_i, y_i) - (RA_i, Dec_i)||^2
        """
        logger.info("Optimizing WCS parameters...")

        # 初期パラメータを推定
        # 画像中心に最も近い制御点を見つける
        center_distances = [
            np.sqrt((cp['x_full'] - center_x) ** 2 + (cp['y_full'] - center_y) ** 2)
            for cp in control_points
        ]
        center_idx = np.argmin(center_distances)
        center_point = control_points[center_idx]

        crval_init = [center_point['ra'], center_point['dec']]
        crpix_init = [center_x + 1, center_y + 1]  # FITS is 1-based

        # CD matrixの初期値を推定（全分割画像の平均）
        cd_matrices = []
        for wcs in self.split_wcs_list:
            if hasattr(wcs.wcs, 'cd') and wcs.wcs.cd is not None:
                cd_matrices.append(wcs.wcs.cd)

        if cd_matrices:
            cd_init = np.mean(cd_matrices, axis=0)
        else:
            # デフォルト値（1"/pixel, 回転なし）
            pixel_scale_deg = 1.0 / 3600.0  # 1 arcsec/pixel
            cd_init = np.array([
                [-pixel_scale_deg, 0.0],
                [0.0, pixel_scale_deg]
            ])

        # パラメータベクトル: [crval1, crval2, cd11, cd12, cd21, cd22]
        params_init = np.array([
            crval_init[0], crval_init[1],
            cd_init[0, 0], cd_init[0, 1],
            cd_init[1, 0], cd_init[1, 1]
        ])

        # 残差関数
        def residual_function(params):
            crval1, crval2, cd11, cd12, cd21, cd22 = params

            residuals = []
            for cp, weight in zip(control_points, weights):
                # WCSを構築
                temp_wcs = WCS(naxis=2)
                temp_wcs.wcs.crpix = crpix_init
                temp_wcs.wcs.crval = [crval1, crval2]
                temp_wcs.wcs.cd = np.array([[cd11, cd12], [cd21, cd22]])
                temp_wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']

                try:
                    # ピクセル→天球座標変換
                    sky_pred = temp_wcs.pixel_to_world(cp['x_full'], cp['y_full'])

                    # 角距離（度）
                    sky_true = SkyCoord(
                        ra=cp['ra'] * u.degree,
                        dec=cp['dec'] * u.degree
                    )
                    separation = sky_pred.separation(sky_true).degree

                    # 重み付き残差
                    residuals.append(separation * np.sqrt(weight))

                except Exception:
                    residuals.append(1.0)  # ペナルティ

            return np.array(residuals)

        # 最適化実行
        result = least_squares(
            residual_function,
            params_init,
            method='lm',  # Levenberg-Marquardt
            verbose=0
        )

        if not result.success:
            logger.warning(f"WCS optimization did not converge: {result.message}")

        # 最適パラメータからWCSを構築
        crval1, crval2, cd11, cd12, cd21, cd22 = result.x

        integrated_wcs = WCS(naxis=2)
        integrated_wcs.wcs.crpix = crpix_init
        integrated_wcs.wcs.crval = [crval1, crval2]
        integrated_wcs.wcs.cd = np.array([[cd11, cd12], [cd21, cd22]])
        integrated_wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
        integrated_wcs.wcs.radesys = 'ICRS'
        integrated_wcs.wcs.equinox = 2000.0

        # ピクセルスケールを計算
        pixel_scale_deg = np.sqrt(abs(cd11 * cd22 - cd12 * cd21))
        pixel_scale_arcsec = pixel_scale_deg * 3600.0

        logger.info(
            f"WCS optimization completed: "
            f"RA={crval1:.4f}°, Dec={crval2:.4f}°, "
            f"scale={pixel_scale_arcsec:.2f}\"/pix"
        )

        return integrated_wcs

    def _integrate_wcs_central_tile(self) -> WCS:
        """
        中心タイル基準法による簡易WCS統合

        画像中心に最も近い分割画像のWCSをオフセット調整して使用
        """
        logger.info("Using central tile method for WCS integration")

        center_x = self.original_width / 2.0
        center_y = self.original_height / 2.0

        # 中心に最も近いタイルを見つける
        min_dist = float('inf')
        central_idx = 0

        for idx, region in enumerate(self.split_regions):
            if not self.solve_results[idx]['success']:
                continue

            tile_center_x = region['center_x']
            tile_center_y = region['center_y']

            dist = np.sqrt(
                (tile_center_x - center_x) ** 2 + (tile_center_y - center_y) ** 2
            )

            if dist < min_dist:
                min_dist = dist
                central_idx = idx

        central_region = self.split_regions[central_idx]
        central_wcs = self.split_wcs_list[central_idx]

        logger.info(f"Using central tile [{central_region['index']}] for WCS")

        # オフセット調整
        integrated_wcs = self.transform_split_wcs_to_full_image(
            central_wcs,
            central_region['x_start'],
            central_region['y_start']
        )

        return integrated_wcs

    def _find_adjacent_pairs(self) -> List[Tuple[int, int]]:
        """隣接する分割画像のペアを見つける"""
        pairs = []

        for i, region_i in enumerate(self.split_regions):
            row_i, col_i = region_i['index']

            for j, region_j in enumerate(self.split_regions):
                if j <= i:
                    continue

                row_j, col_j = region_j['index']

                # 横または縦に隣接
                if (abs(row_i - row_j) == 1 and col_i == col_j) or \
                   (abs(col_i - col_j) == 1 and row_i == row_j):
                    pairs.append((i, j))

        return pairs

    def _calculate_overlap_region(
        self,
        region_i: Dict,
        region_j: Dict
    ) -> Optional[Dict]:
        """2つの領域のオーバーラップを計算"""
        x_start = max(region_i['x_start'], region_j['x_start'])
        y_start = max(region_i['y_start'], region_j['y_start'])
        x_end = min(region_i['x_end'], region_j['x_end'])
        y_end = min(region_i['y_end'], region_j['y_end'])

        if x_start >= x_end or y_start >= y_end:
            return None

        return {
            'x_start': x_start,
            'y_start': y_start,
            'x_end': x_end,
            'y_end': y_end
        }

    def _generate_grid_in_region(
        self,
        region: Dict,
        spacing: int
    ) -> List[Tuple[int, int]]:
        """領域内にグリッド点を生成"""
        points = []

        x_coords = range(region['x_start'], region['x_end'], spacing)
        y_coords = range(region['y_start'], region['y_end'], spacing)

        for x in x_coords:
            for y in y_coords:
                points.append((x, y))

        return points
