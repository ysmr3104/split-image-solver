"""
--list-equipment と --recommend-grid のテスト
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON = sys.executable
MAIN_PY = str(Path(__file__).parent.parent.parent / "python" / "main.py")
PROJECT_ROOT = str(Path(__file__).parent.parent.parent)


def run_main(*args):
    """main.py をサブプロセスで実行し (stdout, stderr, returncode) を返す"""
    cmd = [PYTHON, MAIN_PY] + list(args)
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": PROJECT_ROOT, "PATH": "/usr/bin:/bin:/usr/local/bin"},
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


class TestListEquipment:
    """--list-equipment のテスト"""

    def test_list_equipment_returns_json(self):
        stdout, _, rc = run_main("--list-equipment")
        assert rc == 0
        data = json.loads(stdout)
        assert "cameras" in data
        assert "lenses" in data

    def test_list_equipment_has_camera_fields(self):
        stdout, _, _ = run_main("--list-equipment")
        data = json.loads(stdout)
        for name, cam in data["cameras"].items():
            assert "display_name" in cam
            assert "pixel_pitch_um" in cam
            assert "sensor_width_mm" in cam

    def test_list_equipment_has_lens_fields(self):
        stdout, _, _ = run_main("--list-equipment")
        data = json.loads(stdout)
        for name, lens in data["lenses"].items():
            assert "display_name" in lens
            assert "focal_length_mm" in lens
            assert "type" in lens

    def test_list_equipment_no_input_required(self):
        """--list-equipment 使用時に --input/--output が不要"""
        stdout, _, rc = run_main("--list-equipment")
        assert rc == 0

    def test_list_equipment_known_camera(self):
        """equipment.yaml に Sony ILCE-7RM5 が含まれる"""
        stdout, _, _ = run_main("--list-equipment")
        data = json.loads(stdout)
        assert "Sony ILCE-7RM5" in data["cameras"]
        assert data["cameras"]["Sony ILCE-7RM5"]["pixel_pitch_um"] == 3.76

    def test_list_equipment_known_lens(self):
        """equipment.yaml に SEL14F18GM が含まれる"""
        stdout, _, _ = run_main("--list-equipment")
        data = json.loads(stdout)
        assert "Sony FE 14mm f/1.8 GM" in data["lenses"]
        assert data["lenses"]["Sony FE 14mm f/1.8 GM"]["focal_length_mm"] == 14.0

    def test_list_equipment_fisheye_lens(self):
        """equipment.yaml に Sigma 15mm Fisheye が含まれる"""
        stdout, _, _ = run_main("--list-equipment")
        data = json.loads(stdout)
        assert "Sigma 15mm f/2.8 EX DG Diagonal Fisheye" in data["lenses"]
        lens = data["lenses"]["Sigma 15mm f/2.8 EX DG Diagonal Fisheye"]
        assert lens["focal_length_mm"] == 15.0
        assert lens["type"] == "fisheye_equisolid"


class TestRecommendGrid:
    """--recommend-grid のテスト"""

    def test_recommend_grid_requires_focal_length_and_pixel_pitch(self):
        """--focal-length と --pixel-pitch が必須"""
        stdout, _, rc = run_main("--recommend-grid")
        assert rc == 1
        data = json.loads(stdout)
        assert "error" in data

    def test_recommend_grid_without_image_size(self):
        """画像サイズなしでもピクセルスケールは返す"""
        stdout, _, rc = run_main(
            "--recommend-grid", "--focal-length", "14", "--pixel-pitch", "3.76"
        )
        assert rc == 0
        data = json.loads(stdout)
        assert "pixel_scale_arcsec" in data
        assert "recommended_grid" not in data  # 画像サイズなしのため

    def test_recommend_grid_ultra_wide(self):
        """14mm + 9728x6656 → 8x8 推奨"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "14",
            "--pixel-pitch",
            "3.76",
            "--image-width",
            "9728",
            "--image-height",
            "6656",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["recommended_grid"] == "8x8"
        assert data["diagonal_fov_deg"] > 90

    def test_recommend_grid_standard_wide(self):
        """35mm + 6000x4000 → 5x5 推奨 (対角FOV ~70°)"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "35",
            "--pixel-pitch",
            "5.93",
            "--image-width",
            "6000",
            "--image-height",
            "4000",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["recommended_grid"] == "5x5"
        assert data["diagonal_fov_deg"] > 60
        assert data["diagonal_fov_deg"] <= 90

    def test_recommend_grid_narrow(self):
        """200mm + 6000x4000 → 2x2 推奨"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "200",
            "--pixel-pitch",
            "5.93",
            "--image-width",
            "6000",
            "--image-height",
            "4000",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["recommended_grid"] == "2x2"
        assert data["diagonal_fov_deg"] <= 30

    def test_recommend_grid_fisheye_equisolid(self):
        """Sigma 15mm fisheye + α7RIV → 12x8 推奨 (対角FOV ~183°)"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "15",
            "--pixel-pitch",
            "3.76",
            "--image-width",
            "9533",
            "--image-height",
            "6344",
            "--lens-type",
            "fisheye_equisolid",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["lens_type"] == "fisheye_equisolid"
        assert data["projection"] == "equisolid"
        assert data["diagonal_fov_deg"] > 150
        assert data["recommended_grid"] == "12x8"

    def test_recommend_grid_fisheye_has_projection_info(self):
        """--recommend-grid の出力に投影型情報が含まれる"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "15",
            "--pixel-pitch",
            "3.76",
            "--lens-type",
            "fisheye_equisolid",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["lens_type"] == "fisheye_equisolid"
        assert data["projection"] == "equisolid"

    def test_recommend_grid_rectilinear_unchanged(self):
        """rectilinearレンズの推奨は従来と同じ"""
        stdout, _, rc = run_main(
            "--recommend-grid",
            "--focal-length",
            "14",
            "--pixel-pitch",
            "3.76",
            "--image-width",
            "9728",
            "--image-height",
            "6656",
        )
        assert rc == 0
        data = json.loads(stdout)
        assert data["recommended_grid"] == "8x8"
        assert data["lens_type"] == "rectilinear"


class TestInputOutputValidation:
    """--input/--output のバリデーションテスト"""

    def test_normal_mode_requires_input(self):
        """通常モードでは --input が必須"""
        _, stderr, rc = run_main("--output", "/tmp/out.fits")
        assert rc == 2  # argparse error

    def test_normal_mode_requires_output(self):
        """通常モードでは --output が必須"""
        _, stderr, rc = run_main("--input", "/tmp/in.fits")
        assert rc == 2  # argparse error
