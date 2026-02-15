"""
機材データベースユーティリティ
FITS/XISF ヘッダーからカメラ・レンズ情報を自動判別する
"""

import yaml
from pathlib import Path
from typing import Dict, Optional, Tuple
from utils.logger import get_logger

logger = get_logger()

# デフォルトの equipment.yaml パス
_DEFAULT_EQUIPMENT_PATH = Path(__file__).parent.parent.parent / "config" / "equipment.yaml"


def load_equipment_db(path: Optional[Path] = None) -> Dict:
    """機材データベースを読み込む"""
    db_path = path or _DEFAULT_EQUIPMENT_PATH
    if not db_path.exists():
        logger.warning(f"Equipment database not found: {db_path}")
        return {"cameras": {}, "lenses": {}}
    with open(db_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def lookup_camera(db: Dict, instrume: str) -> Optional[Dict]:
    """INSTRUME ヘッダー値からカメラ情報を検索"""
    cameras = db.get("cameras", {})
    # 完全一致
    if instrume in cameras:
        return cameras[instrume]
    # 部分一致（大文字小文字無視）
    instrume_lower = instrume.lower()
    for key, cam in cameras.items():
        if key.lower() == instrume_lower:
            return cam
    return None


def lookup_lens(db: Dict, focal_length_mm: float, camera_maker: Optional[str] = None) -> Optional[Dict]:
    """焦点距離（とカメラメーカー）からレンズ情報を検索"""
    lenses = db.get("lenses", {})
    candidates = []
    for name, lens in lenses.items():
        if abs(lens.get("focal_length_mm", 0) - focal_length_mm) < 0.5:
            if camera_maker and "camera_makers" in lens:
                if camera_maker in lens["camera_makers"]:
                    candidates.append((name, lens))
            else:
                candidates.append((name, lens))
    if len(candidates) == 1:
        return candidates[0][1]
    if len(candidates) > 1:
        logger.info(f"複数のレンズ候補: {[c[0] for c in candidates]}（最初の候補を使用）")
        return candidates[0][1]
    return None


def detect_equipment_from_header(header: Dict, db: Optional[Dict] = None) -> Tuple[Optional[Dict], Optional[Dict], Dict]:
    """
    FITS/XISF ヘッダーからカメラ・レンズ情報を自動検出

    Returns:
        (camera_info, lens_info, extracted_params)
        extracted_params: {instrume, focal_length, aperture_diameter, f_number, pixel_scale, ...}
    """
    if db is None:
        db = load_equipment_db()

    params = {}

    # INSTRUME
    instrume = _extract_header_value(header, "INSTRUME")
    if instrume:
        params["instrume"] = instrume

    # FOCALLEN
    focal_length = _extract_header_float(header, "FOCALLEN")
    if focal_length:
        params["focal_length_mm"] = focal_length

    # APTDIA (有効口径 mm)
    aptdia = _extract_header_float(header, "APTDIA")
    if aptdia:
        params["aperture_diameter_mm"] = aptdia
        if focal_length:
            params["f_number"] = focal_length / aptdia

    # カメラ検索
    camera_info = None
    if instrume:
        camera_info = lookup_camera(db, instrume)
        if camera_info:
            logger.info(f"カメラ検出: {camera_info.get('display_name', instrume)}")
            params["pixel_pitch_um"] = camera_info.get("pixel_pitch_um")
            params["native_resolution"] = camera_info.get("native_resolution")

    # レンズ検索
    lens_info = None
    if focal_length:
        camera_maker = camera_info.get("maker") if camera_info else None
        lens_info = lookup_lens(db, focal_length, camera_maker)
        if lens_info:
            logger.info(f"レンズ検出: {lens_info.get('display_name', 'unknown')} ({lens_info.get('type', 'unknown')})")

    return camera_info, lens_info, params


def _extract_header_value(header, key):
    """ヘッダーから文字列値を取得（FITS/XISF両対応）"""
    val = header.get(key)
    if val is None:
        return None
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, list) and len(val) > 0:
        if isinstance(val[0], dict) and "value" in val[0]:
            return str(val[0]["value"]).strip()
    return str(val).strip() if val else None


def _extract_header_float(header, key):
    """ヘッダーから数値を取得"""
    val = _extract_header_value(header, key)
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None
