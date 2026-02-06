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
            solve_results: List[Dict] プレートソルブ結果（品質情報含む）
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
        new_crpix = [
            full_wcs.wcs.crpix[0] + offset_x,
            full_wcs.wcs.crpix[1] + offset_y
        ]
        full_wcs.wcs.crpix = new_crpix

        # SIPのCRPIXも同期
        if full_wcs.sip is not None:
            from astropy.wcs import Sip
            full_wcs.sip = Sip(
                full_wcs.sip.a, full_wcs.sip.b,
                full_wcs.sip.ap, full_wcs.sip.bp,
                new_crpix
            )

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
        control_points_per_tile: int = 100
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

        Stage 1: 中心タイルのWCSを元画像座標系に変換してTANベースとする
        Stage 2: CD行列の微調整（全制御点を使用、CRVALは固定）
        Stage 3: 残差にSIP歪み多項式をフィット
        Stage 4: TAN vs SIP精度比較、良い方を採用
        """
        logger.info("Optimizing WCS parameters...")

        crpix = [center_x + 1, center_y + 1]  # FITS is 1-based

        # === Stage 1: 中心タイルのWCSをベースにする ===
        # 画像中心に最も近いタイルを見つける
        min_dist = float('inf')
        central_idx = 0
        for idx, region in enumerate(self.split_regions):
            if not self.solve_results[idx]['success']:
                continue
            tile_cx = (region['x_start'] + region.get('x_end', region['x_start'] + region['width'])) / 2.0
            tile_cy = (region['y_start'] + region.get('y_end', region['y_start'] + region['height'])) / 2.0
            dist = np.sqrt((tile_cx - center_x) ** 2 + (tile_cy - center_y) ** 2)
            if dist < min_dist:
                min_dist = dist
                central_idx = idx

        central_wcs = self.split_wcs_list[central_idx]
        central_region = self.split_regions[central_idx]

        # 中心タイルのWCSを元画像座標系に変換
        # タイルローカル座標 → 元画像座標: x_full = x_local + x_start
        # WCS: CRPIX をオフセット分だけずらす
        x_offset = central_region['x_start']
        y_offset = central_region['y_start']

        base_wcs = central_wcs.deepcopy()
        new_crpix = [
            base_wcs.wcs.crpix[0] + x_offset,
            base_wcs.wcs.crpix[1] + y_offset
        ]
        base_wcs.wcs.crpix = new_crpix

        # SIPのCRPIXも同期（SIPはpixel_to_worldで独自のCRPIXを使うため）
        if base_wcs.sip is not None:
            from astropy.wcs import Sip
            base_wcs.sip = Sip(
                base_wcs.sip.a, base_wcs.sip.b,
                base_wcs.sip.ap, base_wcs.sip.bp,
                new_crpix
            )

        # CRVALを画像中心のピクセルから計算
        sky_center = base_wcs.pixel_to_world(center_x, center_y)
        crval = [sky_center.ra.degree, sky_center.dec.degree]
        cd = base_wcs.wcs.cd.copy()

        logger.info(
            f"Stage 1: Base from central tile [{central_region['index']}]: "
            f"RA={crval[0]:.4f}°, Dec={crval[1]:.4f}°"
        )

        # CRPIXを画像中心に再設定
        tan_wcs = WCS(naxis=2)
        tan_wcs.wcs.crpix = crpix
        tan_wcs.wcs.crval = crval
        tan_wcs.wcs.cd = cd
        tan_wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
        tan_wcs.wcs.radesys = 'ICRS'
        tan_wcs.wcs.equinox = 2000.0

        # 中心タイルベースの精度
        base_mean_err = self._evaluate_wcs_at_control_points(
            tan_wcs, control_points, weights
        )
        logger.info(f"Central tile base accuracy: weighted mean = {base_mean_err * 60:.2f} arcmin")

        # === Stage 2: CD行列の微調整（CRVALは固定）===
        logger.info("Stage 2: Refining CD matrix...")

        cd_init = np.array([cd[0, 0], cd[0, 1], cd[1, 0], cd[1, 1]])

        def cd_residual_function(cd_params):
            cd11, cd12, cd21, cd22 = cd_params
            residuals = []
            temp_wcs = WCS(naxis=2)
            temp_wcs.wcs.crpix = crpix
            temp_wcs.wcs.crval = crval
            temp_wcs.wcs.cd = np.array([[cd11, cd12], [cd21, cd22]])
            temp_wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
            for cp, weight in zip(control_points, weights):
                try:
                    sky_pred = temp_wcs.pixel_to_world(cp['x_full'], cp['y_full'])
                    sky_true = SkyCoord(ra=cp['ra'] * u.degree, dec=cp['dec'] * u.degree)
                    separation = sky_pred.separation(sky_true).degree
                    residuals.append(separation * np.sqrt(weight))
                except Exception:
                    residuals.append(1.0)
            return np.array(residuals)

        result = least_squares(cd_residual_function, cd_init, method='lm', verbose=0)
        cd11, cd12, cd21, cd22 = result.x

        pixel_scale_deg = np.sqrt(abs(cd11 * cd22 - cd12 * cd21))
        pixel_scale_arcsec = pixel_scale_deg * 3600.0

        # 更新されたTAN WCS
        tan_wcs.wcs.cd = np.array([[cd11, cd12], [cd21, cd22]])
        tan_mean_err = self._evaluate_wcs_at_control_points(
            tan_wcs, control_points, weights
        )
        logger.info(
            f"Refined TAN: scale={pixel_scale_arcsec:.2f}\"/pix, "
            f"accuracy = {tan_mean_err * 60:.2f} arcmin"
        )

        # === Stage 3: SIP歪み多項式のフィット ===
        logger.info("Stage 3: Fitting SIP distortion polynomials...")

        # 制御点での残差を計算（ピクセル単位）
        u_coords = []
        v_coords = []
        du_residuals = []
        dv_residuals = []
        w_array = []

        for cp, weight in zip(control_points, weights):
            try:
                sky_true = SkyCoord(ra=cp['ra'] * u.degree, dec=cp['dec'] * u.degree)
                x_ideal, y_ideal = tan_wcs.world_to_pixel(sky_true)

                du = float(x_ideal) - cp['x_full']
                dv = float(y_ideal) - cp['y_full']

                u_val = cp['x_full'] - crpix[0]
                v_val = cp['y_full'] - crpix[1]

                u_coords.append(u_val)
                v_coords.append(v_val)
                du_residuals.append(du)
                dv_residuals.append(dv)
                w_array.append(weight)

            except Exception:
                continue

        u_coords = np.array(u_coords)
        v_coords = np.array(v_coords)
        du_residuals = np.array(du_residuals)
        dv_residuals = np.array(dv_residuals)
        w_array = np.array(w_array)

        # ピクセル残差が小さい場合はSIPスキップ
        rms_residual = np.sqrt(np.mean(du_residuals**2 + dv_residuals**2))
        logger.info(f"TAN pixel residuals RMS: {rms_residual:.2f} pixels")

        if rms_residual < 0.5:
            logger.info("Pixel residuals are small, skipping SIP fit")
            return tan_wcs

        # 座標を正規化（数値安定性の向上）
        coord_scale = max(
            np.max(np.abs(u_coords)), np.max(np.abs(v_coords)), 1.0
        )
        u_norm = u_coords / coord_scale
        v_norm = v_coords / coord_scale

        # SIP多項式をフィット（3次）
        # 広角レンズ（FOV > 30°）では高次SIPが有効
        fov_estimate_deg = pixel_scale_deg * max(self.original_width, self.original_height)
        sip_order = 5 if fov_estimate_deg > 30 else 3
        logger.info(f"Estimated FOV: {fov_estimate_deg:.1f}°, SIP order: {sip_order}")
        design_cols = []
        col_orders = []  # (p, q) for each column
        for total_order in range(2, sip_order + 1):
            for p in range(total_order, -1, -1):
                q = total_order - p
                design_cols.append(u_norm**p * v_norm**q)
                col_orders.append((p, q))

        design_matrix = np.column_stack(design_cols)

        # 重み付き最小二乗（sqrt(w)を使用 — 正しい重み付け）
        sqrt_w = np.sqrt(w_array)
        WX = design_matrix * sqrt_w[:, np.newaxis]
        Wdu = du_residuals * sqrt_w
        Wdv = dv_residuals * sqrt_w

        a_norm_coeffs, _, _, _ = np.linalg.lstsq(WX, Wdu, rcond=None)
        b_norm_coeffs, _, _, _ = np.linalg.lstsq(WX, Wdv, rcond=None)

        # SIP補正後の残差を計算
        du_predicted = design_matrix @ a_norm_coeffs
        dv_predicted = design_matrix @ b_norm_coeffs
        du_corrected = du_residuals - du_predicted
        dv_corrected = dv_residuals - dv_predicted
        rms_after = np.sqrt(np.mean(du_corrected**2 + dv_corrected**2))

        logger.info(
            f"SIP pixel fit: {rms_residual:.2f} -> {rms_after:.2f} pixels "
            f"(improvement: {(1 - rms_after / max(rms_residual, 1e-10)) * 100:.1f}%)"
        )

        # 正規化係数を元のスケールに変換
        # a[p,q] = a_norm[p,q] / coord_scale^(p+q)
        from astropy.wcs import Sip

        a = np.zeros((sip_order + 1, sip_order + 1))
        b = np.zeros((sip_order + 1, sip_order + 1))
        for idx, (p, q) in enumerate(col_orders):
            a[p, q] = a_norm_coeffs[idx] / coord_scale**(p + q)
            b[p, q] = b_norm_coeffs[idx] / coord_scale**(p + q)

        # 逆SIP係数をグリッドフィットで計算
        ap, bp = self._compute_inverse_sip(a, b, sip_order, crpix)

        # SIP付きWCSを構築
        sip_wcs = WCS(naxis=2)
        sip_wcs.wcs.crpix = crpix
        sip_wcs.wcs.crval = crval
        sip_wcs.wcs.cd = np.array([[cd11, cd12], [cd21, cd22]])
        sip_wcs.wcs.ctype = ['RA---TAN-SIP', 'DEC--TAN-SIP']
        sip_wcs.wcs.radesys = 'ICRS'
        sip_wcs.wcs.equinox = 2000.0
        sip_wcs.sip = Sip(a, b, ap, bp, crpix)

        # === Stage 4: TAN vs SIP精度比較 ===
        sip_mean_err = self._evaluate_wcs_at_control_points(
            sip_wcs, control_points, weights
        )
        logger.info(f"TAN+SIP accuracy: weighted mean = {sip_mean_err * 60:.2f} arcmin")

        # SIPが少なくとも5%改善しない場合はTAN-onlyを使用
        if sip_mean_err < tan_mean_err * 0.95:
            improvement_pct = (1 - sip_mean_err / tan_mean_err) * 100
            logger.info(
                f"SIP improves accuracy by {improvement_pct:.1f}%, using TAN-SIP "
                f"(scale={pixel_scale_arcsec:.2f}\"/pix, SIP order={sip_order})"
            )
            return sip_wcs
        else:
            logger.info(
                f"SIP does not improve accuracy "
                f"(TAN: {tan_mean_err * 60:.2f}' vs SIP: {sip_mean_err * 60:.2f}'), "
                f"using TAN-only (scale={pixel_scale_arcsec:.2f}\"/pix)"
            )
            return tan_wcs

    def _evaluate_wcs_at_control_points(
        self,
        wcs_obj: WCS,
        control_points: List[Dict],
        weights: List[float]
    ) -> float:
        """
        制御点でのWCS精度を評価（重み付き平均誤差を度単位で返す）
        """
        weighted_sum = 0.0
        weight_total = 0.0
        for cp, w in zip(control_points, weights):
            try:
                sky_pred = wcs_obj.pixel_to_world(cp['x_full'], cp['y_full'])
                sky_true = SkyCoord(ra=cp['ra'] * u.degree, dec=cp['dec'] * u.degree)
                err_deg = sky_pred.separation(sky_true).degree
                weighted_sum += err_deg * w
                weight_total += w
            except Exception:
                continue
        return weighted_sum / weight_total if weight_total > 0 else float('inf')

    def _compute_inverse_sip(
        self,
        a: np.ndarray,
        b: np.ndarray,
        sip_order: int,
        crpix: List[float]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        逆SIP係数（AP, BP）をグリッドフィットで計算

        順方向SIP: u' = u + A(u,v) を使って
        逆方向: u ≈ u' + AP(u',v') をフィット
        """
        # ピクセル空間でグリッドを生成
        n_grid = 50
        u_range = np.linspace(-self.original_width / 2, self.original_width / 2, n_grid)
        v_range = np.linspace(-self.original_height / 2, self.original_height / 2, n_grid)
        uu, vv = np.meshgrid(u_range, v_range)
        u_flat = uu.ravel()
        v_flat = vv.ravel()

        # 順方向SIPを適用
        du = self._eval_sip_polynomial(a, u_flat, v_flat)
        dv = self._eval_sip_polynomial(b, u_flat, v_flat)

        u_prime = u_flat + du
        v_prime = v_flat + dv

        # 逆方向をフィット: AP(u',v') ≈ u - u' = -du
        coord_scale = max(
            np.max(np.abs(u_prime)), np.max(np.abs(v_prime)), 1.0
        )
        up_norm = u_prime / coord_scale
        vp_norm = v_prime / coord_scale

        design_cols = []
        col_orders = []
        for total_order in range(2, sip_order + 1):
            for p in range(total_order, -1, -1):
                q = total_order - p
                design_cols.append(up_norm**p * vp_norm**q)
                col_orders.append((p, q))

        design_matrix = np.column_stack(design_cols)

        ap_norm_coeffs, _, _, _ = np.linalg.lstsq(design_matrix, -du, rcond=None)
        bp_norm_coeffs, _, _, _ = np.linalg.lstsq(design_matrix, -dv, rcond=None)

        ap = np.zeros((sip_order + 1, sip_order + 1))
        bp = np.zeros((sip_order + 1, sip_order + 1))
        for idx, (p, q) in enumerate(col_orders):
            ap[p, q] = ap_norm_coeffs[idx] / coord_scale**(p + q)
            bp[p, q] = bp_norm_coeffs[idx] / coord_scale**(p + q)

        return ap, bp

    @staticmethod
    def _eval_sip_polynomial(
        coeffs: np.ndarray,
        u: np.ndarray,
        v: np.ndarray
    ) -> np.ndarray:
        """SIP多項式を評価"""
        result = np.zeros_like(u)
        for p in range(coeffs.shape[0]):
            for q in range(coeffs.shape[1]):
                if p + q >= 2 and coeffs[p, q] != 0:
                    result += coeffs[p, q] * u**p * v**q
        return result

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
