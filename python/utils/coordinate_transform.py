"""
座標変換ユーティリティ
"""

# レンズ投影型 → 内部投影名のマッピング
LENS_TYPE_TO_PROJECTION = {
    "rectilinear": "gnomonic",
    "fisheye_equisolid": "equisolid",
    "fisheye_equidistant": "equidistant",
    "fisheye_stereographic": "stereographic",
}
