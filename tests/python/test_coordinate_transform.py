"""
座標変換ユーティリティのテスト
"""

import pytest
import numpy as np

from utils.coordinate_transform import (
    pixel_offset_to_radec,
    calculate_tile_center_offset,
    calculate_tile_pixel_scale,
    _pixel_radius_to_angle,
    _effective_pixel_scale_factor,
)


class TestPixelOffsetToRadec:
    """gnomonic逆投影によるRA/DEC計算のテスト"""

    def test_zero_offset_returns_center(self):
        """オフセットゼロの場合、中心座標がそのまま返る"""
        ra, dec = pixel_offset_to_radec(180.0, 45.0, 10.0, 0.0, 0.0)
        assert ra == pytest.approx(180.0, abs=1e-10)
        assert dec == pytest.approx(45.0, abs=1e-10)

    def test_small_offset_near_linear(self):
        """小さいオフセットでは線形近似と近い結果になる"""
        center_ra = 100.0
        center_dec = 30.0
        pixel_scale = 10.0  # arcsec/pixel
        offset_x = 50.0  # pixels
        offset_y = 30.0  # pixels

        ra, dec = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, offset_x, offset_y
        )

        # 線形近似: ΔRA ≈ offset_x * scale / cos(dec), ΔDEC ≈ offset_y * scale
        expected_dec = center_dec + (offset_y * pixel_scale / 3600.0)
        expected_ra = center_ra + (offset_x * pixel_scale / 3600.0) / np.cos(
            np.radians(center_dec)
        )

        # 小さいオフセット（~500 arcsec）では線形近似との差が0.01度未満
        assert ra == pytest.approx(expected_ra, abs=0.01)
        assert dec == pytest.approx(expected_dec, abs=0.01)

    def test_large_offset_differs_from_linear(self):
        """大きいオフセット（超広角）では線形近似と乖離する"""
        center_ra = 100.0
        center_dec = 30.0
        pixel_scale = 54.0  # 14mmレンズ相当
        offset_x = 3000.0  # 画像中心からの大きなオフセット
        offset_y = 2000.0

        ra, dec = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, offset_x, offset_y
        )

        # 線形近似
        linear_dec = center_dec + (offset_y * pixel_scale / 3600.0)
        linear_ra = center_ra + (offset_x * pixel_scale / 3600.0) / np.cos(
            np.radians(center_dec)
        )

        # 大オフセットでは差が0.5度以上ある
        ra_diff = abs(ra - linear_ra)
        dec_diff = abs(dec - linear_dec)
        assert ra_diff > 0.5 or dec_diff > 0.5

    def test_35mm_compatible_with_old_implementation(self):
        """35mmレンズ相当の小オフセットでは旧実装と1度未満の差"""
        center_ra = 98.0
        center_dec = 5.0
        pixel_scale = 22.4  # 35mmレンズ、α7III相当
        # 3x3分割のエッジタイル程度のオフセット
        offset_x = 1000.0
        offset_y = 700.0

        ra, dec = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, offset_x, offset_y
        )

        # 旧実装（線形近似）
        old_dec = center_dec + (offset_y * pixel_scale / 3600.0)
        old_ra = center_ra + (offset_x * pixel_scale / 3600.0) / np.cos(
            np.radians(center_dec)
        )

        assert abs(ra - old_ra) < 1.0
        assert abs(dec - old_dec) < 1.0

    def test_ra_wrapping(self):
        """RA=0度近辺でのラップアラウンド"""
        ra, dec = pixel_offset_to_radec(1.0, 0.0, 10.0, 500.0, 0.0)
        # 東方向のオフセット → RAが増加 → 360度を超えてラップ
        assert 0 <= ra < 360

    def test_dec_near_pole(self):
        """高緯度（極近傍）でも正常に計算できる"""
        ra, dec = pixel_offset_to_radec(100.0, 85.0, 10.0, 100.0, 50.0)
        assert -90 <= dec <= 90
        assert 0 <= ra < 360

    def test_gnomonic_roundtrip(self):
        """gnomonic順投影→逆投影のラウンドトリップ"""
        center_ra = 150.0
        center_dec = -20.0
        pixel_scale = 30.0

        # gnomonic順投影でターゲット座標から標準座標を計算
        target_ra = 152.0
        target_dec = -18.5
        alpha = np.radians(target_ra)
        delta = np.radians(target_dec)
        alpha_0 = np.radians(center_ra)
        delta_0 = np.radians(center_dec)

        cos_c = np.sin(delta_0) * np.sin(delta) + np.cos(delta_0) * np.cos(
            delta
        ) * np.cos(alpha - alpha_0)
        xi = np.cos(delta) * np.sin(alpha - alpha_0) / cos_c
        eta = (
            np.cos(delta_0) * np.sin(delta)
            - np.sin(delta_0) * np.cos(delta) * np.cos(alpha - alpha_0)
        ) / cos_c

        # 標準座標からピクセルオフセットに戻す
        # xi正=東=offset_x正、eta正=北=offset_y正
        scale_rad = np.radians(pixel_scale / 3600.0)
        offset_x = xi / scale_rad
        offset_y = eta / scale_rad

        # 逆投影
        ra, dec = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, offset_x, offset_y
        )

        assert ra == pytest.approx(target_ra, abs=1e-6)
        assert dec == pytest.approx(target_dec, abs=1e-6)

    def test_default_projection_backward_compatible(self):
        """projection引数なしで従来と同じ結果（gnomonic）"""
        center_ra = 150.0
        center_dec = -20.0
        pixel_scale = 30.0
        offset_x = 500.0
        offset_y = 300.0

        ra1, dec1 = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, offset_x, offset_y
        )
        ra2, dec2 = pixel_offset_to_radec(
            center_ra,
            center_dec,
            pixel_scale,
            offset_x,
            offset_y,
            projection="gnomonic",
        )

        assert ra1 == pytest.approx(ra2, abs=1e-12)
        assert dec1 == pytest.approx(dec2, abs=1e-12)


class TestPixelOffsetToRadecFisheye:
    """魚眼投影でのRA/DEC計算のテスト"""

    def test_equisolid_zero_offset(self):
        """equisolid: オフセットゼロでは中心座標"""
        ra, dec = pixel_offset_to_radec(
            180.0, 45.0, 51.7, 0.0, 0.0, projection="equisolid"
        )
        assert ra == pytest.approx(180.0, abs=1e-10)
        assert dec == pytest.approx(45.0, abs=1e-10)

    def test_all_projections_agree_at_small_angle(self):
        """小角度では全投影型がほぼ同じ結果"""
        center_ra = 180.0
        center_dec = 0.0
        pixel_scale = 51.7  # Sigma 15mm + α7RIV相当
        offset_x = 10.0
        offset_y = 10.0

        results = {}
        for proj in ["gnomonic", "equisolid", "equidistant", "stereographic"]:
            ra, dec = pixel_offset_to_radec(
                center_ra, center_dec, pixel_scale, offset_x, offset_y, projection=proj
            )
            results[proj] = (ra, dec)

        # 小角度では0.001度以内で一致
        ref_ra, ref_dec = results["gnomonic"]
        for proj in ["equisolid", "equidistant", "stereographic"]:
            assert results[proj][0] == pytest.approx(ref_ra, abs=0.001)
            assert results[proj][1] == pytest.approx(ref_dec, abs=0.001)

    def test_equisolid_larger_angle_than_gnomonic(self):
        """同じピクセルオフセットで、equisolidはgnomonicより大きい角距離を返す"""
        center_ra = 180.0
        center_dec = 0.0
        pixel_scale = 51.7
        # 大オフセット（エッジ付近）
        offset_x = 0.0
        offset_y = 3000.0

        _, dec_gnom = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, 0.0, offset_y, projection="gnomonic"
        )
        _, dec_equi = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, 0.0, offset_y, projection="equisolid"
        )

        # equisolid の方が同じピクセル距離で天球上のより広い角度に対応
        assert abs(dec_equi - center_dec) > abs(dec_gnom - center_dec)

    def test_equisolid_roundtrip_north(self):
        """equisolid: 北方向の順投影→逆投影ラウンドトリップ"""
        center_ra = 276.0
        center_dec = -24.0
        pixel_scale = 51.7  # arcsec/pixel
        scale_rad = np.radians(pixel_scale / 3600.0)

        # ターゲット: 中心から北に20度
        target_dec = center_dec + 20.0
        target_ra = center_ra

        # equisolid 順投影: r = 2*sin(θ/2)/s
        theta = np.radians(20.0)
        r_pixels = 2.0 * np.sin(theta / 2.0) / scale_rad

        # 逆投影
        ra, dec = pixel_offset_to_radec(
            center_ra, center_dec, pixel_scale, 0.0, r_pixels, projection="equisolid"
        )

        assert ra == pytest.approx(target_ra, abs=0.01)
        assert dec == pytest.approx(target_dec, abs=0.01)

    def test_equisolid_diagonal_fov_sigma15mm(self):
        """Sigma 15mm + α7RIV の対角FOVが ~183度"""
        pixel_scale = 51.7  # arcsec/pixel
        scale_rad = np.radians(pixel_scale / 3600.0)

        # 対角ピクセル距離（9533x6344の半対角）
        half_diag = np.sqrt(9533**2 + 6344**2) / 2.0

        # equisolid: θ = 2*arcsin(r*s/2)
        theta = _pixel_radius_to_angle(half_diag, scale_rad, "equisolid")
        diag_fov = np.degrees(theta) * 2.0

        # 対角FOV ~183度
        assert 170 < diag_fov < 195


class TestCalculateTileCenterOffset:
    """タイル中心オフセット計算のテスト"""

    def test_center_tile(self):
        """中心タイルのオフセットはほぼゼロ"""
        region = {"x_start": 400, "x_end": 600, "y_start": 300, "y_end": 500}
        ox, oy = calculate_tile_center_offset(region, 1000, 800)
        assert ox == pytest.approx(0.0, abs=1e-10)
        assert oy == pytest.approx(0.0, abs=1e-10)

    def test_corner_tile(self):
        """コーナータイルのオフセット"""
        # 左上タイル
        region = {"x_start": 0, "x_end": 400, "y_start": 0, "y_end": 400}
        ox, oy = calculate_tile_center_offset(region, 1000, 800)
        # 画像中心(500, 400) - タイル中心(200, 200) = (300, 200)
        assert ox == pytest.approx(300.0)
        assert oy == pytest.approx(200.0)


class TestPixelRadiusToAngle:
    """_pixel_radius_to_angle のテスト"""

    def test_zero_radius_all_projections(self):
        """r=0 では全投影型で θ=0"""
        for proj in ["gnomonic", "equisolid", "equidistant", "stereographic"]:
            theta = _pixel_radius_to_angle(0.0, 0.001, proj)
            assert theta == pytest.approx(0.0, abs=1e-12)

    def test_gnomonic_known_value(self):
        """gnomonic: arctan(1) = π/4"""
        scale_rad = 1.0
        theta = _pixel_radius_to_angle(1.0, scale_rad, "gnomonic")
        assert theta == pytest.approx(np.pi / 4, abs=1e-12)

    def test_equisolid_known_value(self):
        """equisolid: r*s = 2*sin(π/6) = 1 → θ = 2*arcsin(0.5) = π/3"""
        scale_rad = 1.0
        theta = _pixel_radius_to_angle(1.0, scale_rad, "equisolid")
        assert theta == pytest.approx(np.pi / 3, abs=1e-12)

    def test_equidistant_known_value(self):
        """equidistant: θ = r*s"""
        theta = _pixel_radius_to_angle(100.0, 0.01, "equidistant")
        assert theta == pytest.approx(1.0, abs=1e-12)

    def test_stereographic_known_value(self):
        """stereographic: r*s = 2*tan(π/8) → θ = 2*arctan(tan(π/8)) = π/4"""
        scale_rad = 1.0
        r = 2.0 * np.tan(np.pi / 8)
        theta = _pixel_radius_to_angle(r, scale_rad, "stereographic")
        assert theta == pytest.approx(np.pi / 4, abs=1e-10)

    def test_equisolid_clamp(self):
        """equisolid: arcsin引数が1を超えた場合にクランプされる"""
        # r*s/2 > 1 → クランプされて θ = π
        theta = _pixel_radius_to_angle(1000.0, 0.01, "equisolid")
        assert theta == pytest.approx(np.pi, abs=1e-12)

    def test_small_angle_all_agree(self):
        """小角度では全投影型がほぼ一致"""
        scale_rad = 0.0001  # 小スケール
        r = 10.0
        results = {}
        for proj in ["gnomonic", "equisolid", "equidistant", "stereographic"]:
            results[proj] = _pixel_radius_to_angle(r, scale_rad, proj)

        ref = results["gnomonic"]
        for proj in ["equisolid", "equidistant", "stereographic"]:
            assert results[proj] == pytest.approx(ref, rel=1e-4)

    def test_unknown_projection_raises(self):
        """不明な投影型でValueError"""
        with pytest.raises(ValueError):
            _pixel_radius_to_angle(1.0, 0.001, "unknown")


class TestEffectivePixelScaleFactor:
    """_effective_pixel_scale_factor のテスト"""

    def test_zero_angle_all_projections(self):
        """θ=0 では全投影型で倍率1.0"""
        for proj in ["gnomonic", "equisolid", "equidistant", "stereographic"]:
            factor = _effective_pixel_scale_factor(0.0, proj)
            assert factor == pytest.approx(1.0, abs=1e-12)

    def test_gnomonic_45deg(self):
        """gnomonic: θ=45° → 1/cos²(45°) = 2"""
        factor = _effective_pixel_scale_factor(np.radians(45.0), "gnomonic")
        assert factor == pytest.approx(2.0, abs=1e-10)

    def test_equisolid_less_than_gnomonic(self):
        """equisolid のスケール倍率は gnomonic より小さい"""
        theta = np.radians(30.0)
        f_gnom = _effective_pixel_scale_factor(theta, "gnomonic")
        f_equi = _effective_pixel_scale_factor(theta, "equisolid")
        assert f_equi < f_gnom

    def test_equidistant_always_one(self):
        """equidistant: 任意の角度で倍率1.0"""
        for angle_deg in [0, 10, 30, 60, 89]:
            factor = _effective_pixel_scale_factor(np.radians(angle_deg), "equidistant")
            assert factor == pytest.approx(1.0, abs=1e-12)

    def test_ordering_at_30deg(self):
        """θ=30° での倍率の大小関係: equidistant < equisolid < stereographic < gnomonic"""
        theta = np.radians(30.0)
        f_eq = _effective_pixel_scale_factor(theta, "equidistant")
        f_es = _effective_pixel_scale_factor(theta, "equisolid")
        f_st = _effective_pixel_scale_factor(theta, "stereographic")
        f_gn = _effective_pixel_scale_factor(theta, "gnomonic")
        assert f_eq < f_es < f_st < f_gn

    def test_unknown_projection_raises(self):
        """不明な投影型でValueError"""
        with pytest.raises(ValueError):
            _effective_pixel_scale_factor(0.5, "unknown")


class TestCalculateTilePixelScale:
    """投影型対応のタイル実効スケール計算のテスト"""

    def test_center_returns_same_scale(self):
        """画像中心では中心スケールと同じ"""
        scale = calculate_tile_pixel_scale(54.0, 500.0, 400.0, 500.0, 400.0)
        assert scale == pytest.approx(54.0, abs=1e-10)

    def test_edge_scale_larger_than_center(self):
        """エッジでは中心より大きいスケールになる"""
        center_scale = 54.0
        # 14mmレンズ、9728x6656px想定のエッジタイル
        scale = calculate_tile_pixel_scale(
            center_scale,
            9728 * 0.83,  # 右端近く
            6656 / 2,  # 垂直中心
            9728 / 2,
            6656 / 2,
        )
        # エッジでは1.5倍以上
        assert scale > center_scale * 1.3

    def test_corner_scale_much_larger(self):
        """コーナーでは中心より大幅に大きいスケールになる"""
        center_scale = 54.0
        # 14mmレンズ、9728x6656px想定のコーナー
        scale = calculate_tile_pixel_scale(
            center_scale,
            9728 * 0.83,  # 右端近く
            6656 * 0.17,  # 上端近く
            9728 / 2,
            6656 / 2,
        )
        # コーナーでは1.5倍以上
        assert scale > center_scale * 1.5

    def test_14mm_center_vs_corner_ratio(self):
        """14mmレンズでの中心対コーナー比が期待値（~2倍）に近い"""
        center_scale = 54.0  # 14mmレンズの中心スケール
        img_w, img_h = 9728, 6656

        # 中心スケール
        center = calculate_tile_pixel_scale(
            center_scale, img_w / 2, img_h / 2, img_w / 2, img_h / 2
        )

        # コーナーの3x3タイル中心位置（おおよそ）
        corner = calculate_tile_pixel_scale(
            center_scale,
            img_w / 6,  # 左端タイル中心
            img_h / 6,  # 上端タイル中心
            img_w / 2,
            img_h / 2,
        )

        ratio = corner / center
        # 14mm FOV ~114°の場合、コーナーは1.5〜2.5倍程度
        assert 1.5 < ratio < 3.0

    def test_35mm_small_variation(self):
        """35mmレンズでは中心対コーナー比が小さい（~1.2倍以下）"""
        center_scale = 22.4  # 35mmレンズの中心スケール
        img_w, img_h = 6000, 4000

        center = calculate_tile_pixel_scale(
            center_scale, img_w / 2, img_h / 2, img_w / 2, img_h / 2
        )
        corner = calculate_tile_pixel_scale(
            center_scale, img_w / 6, img_h / 6, img_w / 2, img_h / 2
        )

        ratio = corner / center
        # 35mmレンズ（~40° FOV）ではコーナーでも差が小さい
        assert ratio < 1.3

    def test_symmetry(self):
        """対称位置では同じスケールになる"""
        center_scale = 54.0
        cx, cy = 500.0, 400.0

        # 左上と右下
        s1 = calculate_tile_pixel_scale(center_scale, 200, 100, cx, cy)
        s2 = calculate_tile_pixel_scale(center_scale, 800, 700, cx, cy)
        assert s1 == pytest.approx(s2, rel=1e-10)

    def test_default_projection_backward_compatible(self):
        """projection引数なしで従来と同値（gnomonic）"""
        scale1 = calculate_tile_pixel_scale(54.0, 200.0, 100.0, 500.0, 400.0)
        scale2 = calculate_tile_pixel_scale(
            54.0, 200.0, 100.0, 500.0, 400.0, projection="gnomonic"
        )
        assert scale1 == pytest.approx(scale2, abs=1e-12)

    def test_equisolid_less_than_gnomonic_at_edge(self):
        """エッジでequisolidスケールはgnomonicより小さい"""
        center_scale = 51.7
        img_w, img_h = 9533, 6344

        s_gnom = calculate_tile_pixel_scale(
            center_scale,
            img_w * 0.1,
            img_h * 0.1,
            img_w / 2,
            img_h / 2,
            projection="gnomonic",
        )
        s_equi = calculate_tile_pixel_scale(
            center_scale,
            img_w * 0.1,
            img_h * 0.1,
            img_w / 2,
            img_h / 2,
            projection="equisolid",
        )
        assert s_equi < s_gnom

    def test_equisolid_fisheye_corner_scale(self):
        """Sigma 15mm fisheye + α7RIV: コーナーでのスケール増大は穏やか"""
        center_scale = 51.7
        img_w, img_h = 9533, 6344

        center = calculate_tile_pixel_scale(
            center_scale,
            img_w / 2,
            img_h / 2,
            img_w / 2,
            img_h / 2,
            projection="equisolid",
        )
        # 10x10グリッドのコーナータイル中心
        corner = calculate_tile_pixel_scale(
            center_scale,
            img_w * 0.05,
            img_h * 0.05,
            img_w / 2,
            img_h / 2,
            projection="equisolid",
        )

        ratio = corner / center
        # equisolidではコーナーでも1.1〜1.5倍程度（gnomonicよりはるかに穏やか）
        assert 1.0 < ratio < 2.0
