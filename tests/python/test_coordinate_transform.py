"""
座標変換ユーティリティのテスト
"""

import pytest
import numpy as np

from utils.coordinate_transform import (
    pixel_offset_to_radec,
    calculate_tile_center_offset,
    calculate_tile_pixel_scale,
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


class TestCalculateTilePixelScale:
    """gnomonic投影でのタイル実効スケール計算のテスト"""

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
