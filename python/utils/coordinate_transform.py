"""
座標変換ユーティリティ
"""

import numpy as np
from typing import Tuple


def pixel_offset_to_radec(
    center_ra: float,
    center_dec: float,
    pixel_scale: float,
    offset_x: float,
    offset_y: float
) -> Tuple[float, float]:
    """
    画像中心からのピクセルオフセットを使って、そのタイルの中心RA/DECを計算

    簡易的なタンジェント平面投影を使用

    Args:
        center_ra: 画像全体の中心RA (degrees)
        center_dec: 画像全体の中心DEC (degrees)
        pixel_scale: ピクセルスケール (arcsec/pixel)
        offset_x: X方向のピクセルオフセット（正 = 東）
        offset_y: Y方向のピクセルオフセット（正 = 北）

    Returns:
        (ra, dec) タイル中心の天球座標 (degrees)
    """
    # ピクセルオフセットを角度に変換 (arcsec -> degrees)
    delta_ra_arcsec = offset_x * pixel_scale
    delta_dec_arcsec = offset_y * pixel_scale

    # DECへのオフセットは単純な足し算
    tile_dec = center_dec + (delta_dec_arcsec / 3600.0)

    # RAへのオフセットはDEC依存（高緯度ほど1度あたりの距離が短い）
    # ΔRA = Δλ / cos(δ)  where δ is declination
    dec_rad = np.radians(center_dec)
    delta_ra_degrees = (delta_ra_arcsec / 3600.0) / np.cos(dec_rad)
    tile_ra = center_ra + delta_ra_degrees

    # RAを0-360度に正規化
    tile_ra = tile_ra % 360.0

    return tile_ra, tile_dec


def calculate_tile_center_offset(
    tile_region: dict,
    image_width: int,
    image_height: int
) -> Tuple[float, float]:
    """
    タイル領域から、画像中心に対するタイル中心のピクセルオフセットを計算

    Args:
        tile_region: タイル領域情報 (x_start, x_end, y_start, y_end)
        image_width: 元画像の幅
        image_height: 元画像の高さ

    Returns:
        (offset_x, offset_y) 画像中心からのピクセルオフセット
    """
    # 画像中心
    image_center_x = image_width / 2.0
    image_center_y = image_height / 2.0

    # タイル中心
    tile_center_x = (tile_region['x_start'] + tile_region['x_end']) / 2.0
    tile_center_y = (tile_region['y_start'] + tile_region['y_end']) / 2.0

    # オフセット（FITS座標系: X=右/東, Y=上/北）
    offset_x = tile_center_x - image_center_x
    offset_y = tile_center_y - image_center_y

    return offset_x, offset_y
