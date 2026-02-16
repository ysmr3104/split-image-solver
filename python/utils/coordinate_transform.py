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
    offset_y: float,
) -> Tuple[float, float]:
    """
    画像中心からのピクセルオフセットを使って、そのタイルの中心RA/DECを計算

    gnomonic（正距）逆投影を使用し、広角画像でも正確な座標変換を行う

    Args:
        center_ra: 画像全体の中心RA (degrees)
        center_dec: 画像全体の中心DEC (degrees)
        pixel_scale: 画像中心でのピクセルスケール (arcsec/pixel)
        offset_x: X方向のピクセルオフセット（正 = 東 = RA増加方向）
        offset_y: Y方向のピクセルオフセット（正 = 北 = DEC増加方向）

    Returns:
        (ra, dec) タイル中心の天球座標 (degrees)
    """
    # ピクセルスケールをラジアンに変換
    scale_rad = np.radians(pixel_scale / 3600.0)

    # 接平面上の標準座標（gnomonic投影）
    # xi: 東が正（RA増加方向）、offset_xも東が正なので同符号
    # eta: 北が正（DEC増加方向）、offset_yも北が正なので同符号
    xi = offset_x * scale_rad
    eta = offset_y * scale_rad

    rho = np.sqrt(xi**2 + eta**2)

    if rho < 1e-12:
        # オフセットがほぼゼロ → 中心座標をそのまま返す
        return center_ra, center_dec

    # gnomonic 逆投影
    c = np.arctan(rho)

    alpha_0 = np.radians(center_ra)
    delta_0 = np.radians(center_dec)

    delta = np.arcsin(
        np.cos(c) * np.sin(delta_0) + eta * np.sin(c) * np.cos(delta_0) / rho
    )
    alpha = alpha_0 + np.arctan2(
        xi * np.sin(c),
        rho * np.cos(delta_0) * np.cos(c) - eta * np.sin(delta_0) * np.sin(c),
    )

    tile_ra = np.degrees(alpha) % 360.0
    tile_dec = np.degrees(delta)

    return tile_ra, tile_dec


def calculate_tile_center_offset(
    tile_region: dict, image_width: int, image_height: int
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
    tile_center_x = (tile_region["x_start"] + tile_region["x_end"]) / 2.0
    tile_center_y = (tile_region["y_start"] + tile_region["y_end"]) / 2.0

    # オフセット（標準天文画像の座標系: 北が上、東が左）
    # X: 左=東=RA増加方向 → ピクセルX増加はRA減少なので符号反転
    # Y: 上=北=Dec増加方向 → ピクセルY増加はDec減少なので符号反転
    offset_x = image_center_x - tile_center_x
    offset_y = image_center_y - tile_center_y

    return offset_x, offset_y


def calculate_tile_pixel_scale(
    center_pixel_scale: float,
    tile_center_x: float,
    tile_center_y: float,
    image_center_x: float,
    image_center_y: float,
) -> float:
    """
    gnomonic投影でのタイル位置における実効ピクセルスケールを計算

    正距投影（TAN）では、画像中心から離れるほどピクセルあたりの天球上の角度が
    大きくなる（歪みが増大する）。この関数はその効果を考慮した実効スケールを返す。

    理論:
        r = 中心からの距離 (pixels)
        theta = arctan(r * center_scale_rad)  # 光軸からの天球上の角度
        effective_scale = center_scale / cos²(theta)

    Args:
        center_pixel_scale: 画像中心でのピクセルスケール (arcsec/pixel)
        tile_center_x: タイル中心のX座標 (pixels)
        tile_center_y: タイル中心のY座標 (pixels)
        image_center_x: 画像中心のX座標 (pixels)
        image_center_y: 画像中心のY座標 (pixels)

    Returns:
        実効ピクセルスケール (arcsec/pixel)
    """
    # 中心からの距離（ピクセル）
    r_pixels = np.sqrt(
        (tile_center_x - image_center_x) ** 2 + (tile_center_y - image_center_y) ** 2
    )

    if r_pixels < 1e-6:
        return center_pixel_scale

    # 中心ピクセルスケールをラジアンに変換
    center_scale_rad = np.radians(center_pixel_scale / 3600.0)

    # 光軸からの天球上の角度
    theta = np.arctan(r_pixels * center_scale_rad)

    # 実効スケール = 中心スケール / cos²(theta)
    cos_theta = np.cos(theta)
    effective_scale = center_pixel_scale / (cos_theta**2)

    return effective_scale
