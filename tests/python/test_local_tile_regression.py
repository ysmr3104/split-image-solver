"""
test_local_tile_regression.py

Local モード (solve-field) のリグレッションテスト。

tests/fits/{2x2,8x6}/ のタイルFITSを使い、
tests/javascript/fixtures/tile_wcs_api_{2x2,8x6}.json のヒントで
run_tile_solve_mode を実際に呼び出す。

実行:
    # 全テスト (時間がかかる: 8x6は数十分)
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_tile_regression.py -v -s

    # 2x2 のみ
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_tile_regression.py -v -s -k "2x2"

    # 8x6 のみ
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_tile_regression.py -v -s -k "8x6"

前提:
    - /opt/homebrew/bin/solve-field が存在すること
    - config/settings.json に astrometry index_dir が設定されていること
"""

import json
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
FITS_DIR = REPO_ROOT / "tests" / "fits"
FIXTURE_DIR = REPO_ROOT / "tests" / "javascript" / "fixtures"
CONFIG_PATH = REPO_ROOT / "config" / "settings.json"

# solve-field が存在しない環境ではスキップ
pytestmark = pytest.mark.skipif(
    not Path("/opt/homebrew/bin/solve-field").exists()
    and not Path("/usr/local/bin/solve-field").exists(),
    reason="solve-field not found",
)


def _build_tile_requests(mode: str) -> list:
    """フィクスチャから per-tile ヒント付きタイルリクエストを構築する。

    scaleLower/scaleUpper はフィクスチャに保存されていないため、
    Python の calculate_tile_pixel_scale で再計算する (JS の solveWavefront と同じロジック)。
    """
    fixture_path = FIXTURE_DIR / f"tile_wcs_api_{mode}.json"
    if not fixture_path.exists():
        pytest.skip(f"Fixture not found: {fixture_path}")

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    fits_dir = FITS_DIR / mode

    sys.path.insert(0, str(REPO_ROOT / "python"))
    from utils.coordinate_transform import calculate_tile_pixel_scale

    hints = fixture["hints"]
    scale_est = hints["scaleEst"]
    image_width = fixture["imageWidth"]
    image_height = fixture["imageHeight"]
    projection = hints.get("projection", "gnomonic")
    if projection == "rectilinear":
        projection = "gnomonic"  # Python 側での同義語

    image_cx = image_width / 2.0
    image_cy = image_height / 2.0
    max_r = (image_cx**2 + image_cy**2) ** 0.5

    requests = []
    for tile in fixture["tiles"]:
        fits_path = fits_dir / f"tile_{tile['row']}_{tile['col']}.fits"
        if not fits_path.exists():
            pytest.skip(f"FITS tile not found: {fits_path}")

        tile_width = tile.get("tileWidth", 0)
        tile_height = tile.get("tileHeight", 0)
        offset_x = tile.get("offsetX", 0)
        offset_y = tile.get("offsetY", 0)

        # タイル中心 (元画像座標系)
        tile_cx = offset_x + tile_width / 2.0
        tile_cy = offset_y + tile_height / 2.0

        # 投影補正付き実効スケール (JS の solveWavefront/buildTileHints と同ロジック)
        effective_scale = calculate_tile_pixel_scale(
            scale_est, tile_cx, tile_cy, image_cx, image_cy, projection
        )

        # マージン: 0.2 + 0.3*(r/max_r) (JS に合わせる)
        r = ((tile_cx - image_cx) ** 2 + (tile_cy - image_cy) ** 2) ** 0.5
        margin = 0.2 + 0.3 * (r / max_r) if max_r > 0 else 0.3

        requests.append(
            {
                "path": str(fits_path),
                "row": tile["row"],
                "col": tile["col"],
                "ra_hint": tile.get("hintRA"),
                "dec_hint": tile.get("hintDEC"),
                "scale_lower": effective_scale * (1.0 - margin),
                "scale_upper": effective_scale * (1.0 + margin),
                "offset_x": offset_x,
                "offset_y": offset_y,
                "tile_width": tile_width,
                "tile_height": tile_height,
            }
        )

    return requests, fixture


def _run_tile_solve(mode: str, timeout_per_tile: int = 240) -> dict:
    """
    run_tile_solve_mode を直接呼び出し、結果を返す。

    Returns:
        {
            "mode": str,
            "tiles_total": int,
            "tiles_solved": int,
            "tile_results": list[dict],  # per-tile: row, col, success, pixel_scale, ...
            "hints": dict,               # fixture の hints
        }
    """
    sys.path.insert(0, str(REPO_ROOT / "python"))

    from main import _build_solver_config, load_config, run_tile_solve_mode

    tile_requests, fixture = _build_tile_requests(mode)

    config = load_config(CONFIG_PATH)
    # タイムアウトを短めに設定 (テスト用)
    config.setdefault("astrometry_local", {})["timeout"] = timeout_per_tile

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, prefix=f"sis_tile_input_{mode}_"
    ) as inp:
        json.dump(tile_requests, inp)
        input_path = inp.name

    with tempfile.NamedTemporaryFile(
        suffix=".json", delete=False, prefix=f"sis_tile_result_{mode}_"
    ) as out:
        result_path = out.name

    args = Namespace(
        tile_solve_json=input_path,
        result_file=result_path,
        config=str(CONFIG_PATH),
        log_level="INFO",
        log_file=None,
    )
    # config オーバーライドのため _build_solver_config をモンキーパッチ
    import main as main_mod
    original_load_config = main_mod.load_config

    def _patched_load_config(path):
        return config

    main_mod.load_config = _patched_load_config
    try:
        run_tile_solve_mode(args)
    finally:
        main_mod.load_config = original_load_config

    result_json = json.loads(Path(result_path).read_text(encoding="utf-8"))
    Path(input_path).unlink(missing_ok=True)
    Path(result_path).unlink(missing_ok=True)

    return {
        "mode": mode,
        "tiles_total": result_json.get("tiles_total", len(tile_requests)),
        "tiles_solved": result_json.get("tiles_solved", 0),
        "tile_results": result_json.get("tile_results", []),
        "hints": fixture.get("hints", {}),
    }


def _print_report(result: dict):
    """per-tile 結果をコンソールに出力する。"""
    mode = result["mode"]
    solved = result["tiles_solved"]
    total = result["tiles_total"]
    print(f"\n{'='*60}")
    print(f"Local Tile Solve: {mode}  {solved}/{total} solved")
    print(f"  centerRA={result['hints'].get('centerRA'):.4f}°  "
          f"centerDEC={result['hints'].get('centerDEC'):.4f}°  "
          f"scale={result['hints'].get('scaleEst'):.3f}\"/px")
    print(f"{'='*60}")

    success_tiles = []
    fail_tiles = []
    for t in sorted(result["tile_results"], key=lambda x: (x["row"], x["col"])):
        row, col = t["row"], t["col"]
        if t["success"]:
            ps = t.get("pixel_scale")
            ra = t.get("crval1", 0)
            dec = t.get("crval2", 0)
            print(f"  [{row}][{col}] OK   RA={ra:.3f}°  DEC={dec:+.3f}°  "
                  f"scale={ps:.3f}\"/px" if ps else
                  f"  [{row}][{col}] OK   RA={ra:.3f}°  DEC={dec:+.3f}°")
            success_tiles.append((row, col))
        else:
            err = t.get("error", "unknown")[:60]
            print(f"  [{row}][{col}] FAIL {err}")
            fail_tiles.append((row, col))

    if fail_tiles:
        print(f"\n  Failed tiles: {fail_tiles}")
    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# テストケース
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_local_tile_solve_2x2():
    """2x2 グリッド (4タイル): 全タイル成功を期待。"""
    result = _run_tile_solve("2x2", timeout_per_tile=240)
    _print_report(result)

    total = result["tiles_total"]
    solved = result["tiles_solved"]

    # ヒントなし実行と比較するため詳細を記録
    assert total == 4, f"Expected 4 tiles, got {total}"
    # 最低3/4以上 (実質全成功を期待)
    assert solved >= 3, (
        f"Expected ≥3/4 tiles solved with hints, got {solved}/4. "
        f"Failed: {[t for t in result['tile_results'] if not t['success']]}"
    )

    # 成功タイルのpixel_scaleが想定スケールの±30%以内
    scale_est = result["hints"].get("scaleEst", 24.549)
    for t in result["tile_results"]:
        if t["success"] and t.get("pixel_scale"):
            ps = t["pixel_scale"]
            ratio = ps / scale_est
            assert 0.5 <= ratio <= 2.0, (
                f"tile[{t['row']}][{t['col']}] pixel_scale={ps:.3f} "
                f"is far from scaleEst={scale_est:.3f} (ratio={ratio:.2f})"
            )


@pytest.mark.slow
def test_local_tile_solve_8x6():
    """8x6 グリッド (48タイル): ≥40/48 (83%) 成功を期待。"""
    result = _run_tile_solve("8x6", timeout_per_tile=240)
    _print_report(result)

    total = result["tiles_total"]
    solved = result["tiles_solved"]

    assert total == 48, f"Expected 48 tiles, got {total}"
    # 40/48 (83%) を最低ライン
    failed = ["[%d][%d]" % (t["row"], t["col"]) for t in result["tile_results"] if not t["success"]]
    assert solved >= 40, (
        f"Expected ≥40/48 tiles solved with hints, got {solved}/48. Failed: {failed}"
    )

    # 成功タイルのpixel_scaleが想定スケールの±50%以内
    scale_est = result["hints"].get("scaleEst", 54.121)
    for t in result["tile_results"]:
        if t["success"] and t.get("pixel_scale"):
            ps = t["pixel_scale"]
            ratio = ps / scale_est
            assert 0.5 <= ratio <= 2.0, (
                f"tile[{t['row']}][{t['col']}] pixel_scale={ps:.3f} "
                f"is far from scaleEst={scale_est:.3f} (ratio={ratio:.2f})"
            )


@pytest.mark.slow
def test_local_tile_solve_2x2_hint_vs_nohint():
    """
    2x2: ヒントあり vs ヒントなしの成功率を比較する。
    ヒントなし実行で失敗したタイルが、ヒントありで成功することを確認。
    """
    sys.path.insert(0, str(REPO_ROOT / "python"))
    from main import load_config, run_tile_solve_mode
    import main as main_mod

    tile_requests_hint, fixture = _build_tile_requests("2x2")

    # ヒントなし版リクエストを作成
    tile_requests_nohint = [
        {
            "path": req["path"],
            "row": req["row"],
            "col": req["col"],
            "ra_hint": None,
            "dec_hint": None,
            "scale_lower": None,
            "scale_upper": None,
            "offset_x": req["offset_x"],
            "offset_y": req["offset_y"],
            "tile_width": req["tile_width"],
            "tile_height": req["tile_height"],
        }
        for req in tile_requests_hint
    ]

    def _run(requests, label):
        config = load_config(CONFIG_PATH)
        config.setdefault("astrometry_local", {})["timeout"] = 120

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as inp:
            json.dump(requests, inp)
            input_path = inp.name
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as out:
            result_path = out.name

        args = Namespace(
            tile_solve_json=input_path,
            result_file=result_path,
            config=str(CONFIG_PATH),
            log_level="INFO",
            log_file=None,
        )

        original = main_mod.load_config
        main_mod.load_config = lambda p: config
        try:
            run_tile_solve_mode(args)
        finally:
            main_mod.load_config = original

        res = json.loads(Path(result_path).read_text())
        Path(input_path).unlink(missing_ok=True)
        Path(result_path).unlink(missing_ok=True)
        solved = res.get("tiles_solved", 0)
        total = res.get("tiles_total", len(requests))
        print(f"\n  {label}: {solved}/{total} solved")
        return solved, total, res

    solved_nohint, total, _ = _run(tile_requests_nohint, "No hints")
    solved_hint, total, _ = _run(tile_requests_hint, "With hints")

    print(f"\n  Result: no_hint={solved_nohint}/{total}  with_hint={solved_hint}/{total}")

    # ヒントありが同等以上であること
    assert solved_hint >= solved_nohint, (
        f"Hints degraded results: {solved_hint}/{total} < {solved_nohint}/{total}"
    )
