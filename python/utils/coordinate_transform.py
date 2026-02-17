"""
座標変換ユーティリティ
"""

import numpy as np
from typing import Tuple

# レンズ投影型 → 内部投影名のマッピング
LENS_TYPE_TO_PROJECTION = {
    "rectilinear": "gnomonic",
    "fisheye_equisolid": "equisolid",
    "fisheye_equidistant": "equidistant",
    "fisheye_stereographic": "stereographic",
}


def _pixel_radius_to_angle(
    r_pixels: float, scale_rad: float, projection: str = "gnomonic"
) -> float:
    """ピクセル距離から天球上の角距離θを計算

    各投影型での r(θ) の逆関数:
      - gnomonic: r = tan(θ)/s → θ = arctan(r*s)
      - equisolid: r = 2*sin(θ/2)/s → θ = 2*arcsin(r*s/2)
      - equidistant: r = θ/s → θ = r*s
      - stereographic: r = 2*tan(θ/2)/s → θ = 2*arctan(r*s/2)

    Args:
        r_pixels: 画像中心からのピクセル距離
        scale_rad: 画像中心でのピクセルスケール (rad/pixel)
        projection: 投影型

    Returns:
        角距離θ (radians)
    """
    rs = r_pixels * scale_rad

    if projection == "gnomonic":
        return np.arctan(rs)
    elif projection == "equisolid":
        arg = np.clip(rs / 2.0, -1.0, 1.0)
        return 2.0 * np.arcsin(arg)
    elif projection == "equidistant":
        return rs
    elif projection == "stereographic":
        return 2.0 * np.arctan(rs / 2.0)
    else:
        raise ValueError(f"Unknown projection: {projection}")


def _effective_pixel_scale_factor(theta: float, projection: str = "gnomonic") -> float:
    """角度θにおけるピクセルスケールの倍率を計算

    dθ/dr を各投影型で計算し、gnomonic 中心での値との比を返す。
    中心 (θ=0) では全投影型で 1.0 を返す。

      - gnomonic: 1/cos²(θ)
      - equisolid: 1/cos(θ/2)
      - equidistant: 1
      - stereographic: 1/cos²(θ/2)

    Args:
        theta: 光軸からの角距離 (radians)
        projection: 投影型

    Returns:
        スケール倍率（≥1.0、中心で1.0）
    """
    if projection == "gnomonic":
        cos_theta = np.cos(theta)
        if abs(cos_theta) < 1e-12:
            return 1e12
        return 1.0 / (cos_theta**2)
    elif projection == "equisolid":
        cos_half = np.cos(theta / 2.0)
        if abs(cos_half) < 1e-12:
            return 1e12
        return 1.0 / cos_half
    elif projection == "equidistant":
        return 1.0
    elif projection == "stereographic":
        cos_half = np.cos(theta / 2.0)
        if abs(cos_half) < 1e-12:
            return 1e12
        return 1.0 / (cos_half**2)
    else:
        raise ValueError(f"Unknown projection: {projection}")


def pixel_offset_to_radec(
    center_ra: float,
    center_dec: float,
    pixel_scale: float,
    offset_x: float,
    offset_y: float,
    projection: str = "gnomonic",
) -> Tuple[float, float]:
    """
    画像中心からのピクセルオフセットを使って、そのタイルの中心RA/DECを計算

    投影型に応じた逆投影を使用し、広角画像でも正確な座標変換を行う

    Args:
        center_ra: 画像全体の中心RA (degrees)
        center_dec: 画像全体の中心DEC (degrees)
        pixel_scale: 画像中心でのピクセルスケール (arcsec/pixel)
        offset_x: X方向のピクセルオフセット（正 = 東 = RA増加方向）
        offset_y: Y方向のピクセルオフセット（正 = 北 = DEC増加方向）
        projection: 投影型 (gnomonic, equisolid, equidistant, stereographic)

    Returns:
        (ra, dec) タイル中心の天球座標 (degrees)
    """
    # ピクセルスケールをラジアンに変換
    scale_rad = np.radians(pixel_scale / 3600.0)

    # ピクセルオフセットから画像面上の距離
    r_pixels = np.sqrt(offset_x**2 + offset_y**2)

    if r_pixels < 1e-12:
        return center_ra, center_dec

    # 方位角 phi（画像面上の方向）
    phi = np.arctan2(offset_x, offset_y)

    # 投影型に応じた角距離 c
    c = _pixel_radius_to_angle(r_pixels, scale_rad, projection)

    # 球面三角法による逆投影（投影型非依存）
    alpha_0 = np.radians(center_ra)
    delta_0 = np.radians(center_dec)

    delta = np.arcsin(
        np.cos(c) * np.sin(delta_0) + np.sin(c) * np.cos(delta_0) * np.cos(phi)
    )
    alpha = alpha_0 + np.arctan2(
        np.sin(c) * np.sin(phi),
        np.cos(c) * np.cos(delta_0) - np.sin(c) * np.sin(delta_0) * np.cos(phi),
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
    projection: str = "gnomonic",
) -> float:
    """
    投影型に応じたタイル位置における実効ピクセルスケールを計算

    画像中心から離れるほどピクセルあたりの天球上の角度が変化する。
    この関数はその効果を考慮した実効スケールを返す。

    Args:
        center_pixel_scale: 画像中心でのピクセルスケール (arcsec/pixel)
        tile_center_x: タイル中心のX座標 (pixels)
        tile_center_y: タイル中心のY座標 (pixels)
        image_center_x: 画像中心のX座標 (pixels)
        image_center_y: 画像中心のY座標 (pixels)
        projection: 投影型 (gnomonic, equisolid, equidistant, stereographic)

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
    theta = _pixel_radius_to_angle(r_pixels, center_scale_rad, projection)

    # 投影型に応じたスケール倍率
    factor = _effective_pixel_scale_factor(theta, projection)

    return center_pixel_scale * factor
