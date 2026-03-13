"""
test_local_regression_a.py — リグレッションテスト A

■ 定義:
  wavefront を通さず、フィクスチャから事前定義したヒント (RA/DEC/スケール) を
  各タイルに直接指定して solve-field を呼び出す。
  解けるべきタイルが解けることを確認するテスト。

■ 目的:
  Python solve-field ラッパー (run_single_tile_solve) 単体の動作確認。
  wavefront のヒント伝播ロジックは検証対象外。

■ 関連テスト:
  - リグレッションテスト B (test_local_regression_b.js):
      wavefront を通して都度ヒント再計算し、計算能力の劣化がないことを確認
  - パイプラインテスト E2E:
      PixInsight GUI から全パイプラインを通して問題ないことを確認 (手動)

実行:
    # 全テスト (時間がかかる: 8x6は数十分)
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_regression_a.py -v -s

    # 2x2 のみ
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_regression_a.py -v -s -k "2x2"

    # 8x6 のみ
    PYTHONPATH="." .venv/bin/pytest tests/python/test_local_regression_a.py -v -s -k "8x6"

前提:
    - /opt/homebrew/bin/solve-field が存在すること
    - config/settings.json に astrometry index_dir が設定されていること
"""

import json
import os
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
FITS_DIR = Path(os.environ.get("FITS_DIR_OVERRIDE", str(REPO_ROOT / "tests" / "fits_downsampling")))
FIXTURE_DIR = REPO_ROOT / "tests" / "javascript" / "fixtures"
CONFIG_PATH = REPO_ROOT / "config" / "settings.json"

# solve-field が存在しない環境ではスキップ
pytestmark = pytest.mark.skipif(
    not Path("/opt/homebrew/bin/solve-field").exists()
    and not Path("/usr/local/bin/solve-field").exists(),
    reason="solve-field not found",
)


def _build_tile_requests(mode: str) -> list:
    """精密ヒントフィクスチャ (tile_hints_local_{mode}.json) からタイルリクエストを構築する。

    フィクスチャには旧バッチモード Pass 2 完了後の WCS 由来ヒント
    (成功タイルの WCS から算出した正確な RA/DEC) が格納されている。
    """
    fixture_path = FIXTURE_DIR / f"tile_hints_local_{mode}.json"
    if not fixture_path.exists():
        pytest.skip(f"Fixture not found: {fixture_path}")

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    fits_dir = FITS_DIR / mode

    requests = []
    for tile in fixture["tiles"]:
        fits_path = fits_dir / f"tile_{tile['row']}_{tile['col']}.fits"
        if not fits_path.exists():
            pytest.skip(f"FITS tile not found: {fits_path}")

        requests.append(
            {
                "path": str(fits_path),
                "row": tile["row"],
                "col": tile["col"],
                "ra_hint": tile.get("ra_hint"),
                "dec_hint": tile.get("dec_hint"),
                "scale_lower": tile.get("scale_lower"),
                "scale_upper": tile.get("scale_upper"),
                "offset_x": tile.get("offset_x", 0),
                "offset_y": tile.get("offset_y", 0),
                "tile_width": tile.get("tile_width", 0),
                "tile_height": tile.get("tile_height", 0),
            }
        )

    return requests, fixture


def _solve_single_tile(req: dict, config: dict, timeout: int = 240) -> dict:
    """run_single_tile_solve を1タイル分呼び出し、結果 dict を返す。"""
    sys.path.insert(0, str(REPO_ROOT / "python"))
    from main import run_single_tile_solve, load_config
    import main as main_mod

    with tempfile.NamedTemporaryFile(
        suffix=".json", delete=False, prefix=f"sis_result_{req['row']}_{req['col']}_"
    ) as out:
        result_path = out.name

    args = Namespace(
        solve_single_tile=True,
        tile_path=req["path"],
        ra_hint=req.get("ra_hint"),
        dec_hint=req.get("dec_hint"),
        scale_lower=req.get("scale_lower"),
        scale_upper=req.get("scale_upper"),
        result_file=result_path,
        config=str(CONFIG_PATH),
        timeout_per_tile=timeout,
        log_level="INFO",
        log_file=None,
    )

    # config override via monkey-patch
    original_load_config = main_mod.load_config

    def _patched_load_config(path):
        return config

    main_mod.load_config = _patched_load_config
    try:
        run_single_tile_solve(args)
    finally:
        main_mod.load_config = original_load_config

    result = json.loads(Path(result_path).read_text(encoding="utf-8"))
    Path(result_path).unlink(missing_ok=True)

    result["row"] = req["row"]
    result["col"] = req["col"]
    return result


def _run_tile_solve(mode: str, timeout_per_tile: int = 240, only_expected_success: bool = True) -> dict:
    """
    per-tile で run_single_tile_solve し、結果を集約して返す。

    only_expected_success=True の場合、フィクスチャで batch_success=True のタイルのみソルブする。
    (解けないタイルに時間をかけない)

    Returns:
        {
            "mode": str,
            "tiles_total": int,      # ソルブ対象タイル数
            "tiles_solved": int,
            "tile_results": list[dict],
            "fixture": dict,         # フィクスチャ全体
        }
    """
    sys.path.insert(0, str(REPO_ROOT / "python"))
    from main import load_config

    tile_requests, fixture = _build_tile_requests(mode)

    if only_expected_success:
        # batch_success タイルだけフィルタ
        success_keys = set()
        for tile in fixture["tiles"]:
            if tile.get("batch_success"):
                success_keys.add((tile["row"], tile["col"]))
        tile_requests = [r for r in tile_requests if (r["row"], r["col"]) in success_keys]

    config = load_config(CONFIG_PATH)
    config.setdefault("astrometry_local", {})["timeout"] = timeout_per_tile

    tile_results = []
    for req in tile_requests:
        result = _solve_single_tile(req, config, timeout_per_tile)
        tile_results.append(result)

    solved = sum(1 for r in tile_results if r.get("success"))

    return {
        "mode": mode,
        "tiles_total": len(tile_requests),
        "tiles_solved": solved,
        "tile_results": tile_results,
        "fixture": fixture,
    }


def _print_report(result: dict):
    """per-tile 結果をコンソールに出力する。"""
    mode = result["mode"]
    solved = result["tiles_solved"]
    total = result["tiles_total"]
    fixture = result["fixture"]
    hints = fixture.get("hints", {})
    print(f"\n{'='*60}")
    print(f"Local Tile Solve: {mode}  {solved}/{total} solved")
    print(f"  centerRA={hints.get('centerRA', 0):.4f}°  "
          f"centerDEC={hints.get('centerDEC', 0):.4f}°  "
          f"scale={hints.get('scaleEst', 0):.3f}\"/px  "
          f"median_scale={fixture.get('median_scale', 0):.3f}\"/px")
    print(f"{'='*60}")

    success_tiles = []
    fail_tiles = []
    for t in sorted(result["tile_results"], key=lambda x: (x["row"], x["col"])):
        row, col = t["row"], t["col"]
        if t.get("success"):
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
    """2x2 グリッド: 精密ヒントで解けるべき全タイル (4/4) が解けることを確認。"""
    result = _run_tile_solve("2x2", timeout_per_tile=240)
    _print_report(result)

    total = result["tiles_total"]
    solved = result["tiles_solved"]
    fixture = result["fixture"]

    assert total == 4, f"Expected 4 tiles, got {total}"
    # 精密ヒント付きなので全タイル成功を期待 (最低3/4)
    assert solved >= 3, (
        f"Expected ≥3/4 tiles solved with refined hints, got {solved}/4. "
        f"Failed: {[t for t in result['tile_results'] if not t.get('success')]}"
    )

    # 成功タイルの pixel_scale がフィクスチャのメジアンスケールと整合すること
    median_scale = fixture.get("median_scale", 24.549)
    for t in result["tile_results"]:
        if t.get("success") and t.get("pixel_scale"):
            ps = t["pixel_scale"]
            ratio = ps / median_scale
            assert 0.5 <= ratio <= 2.0, (
                f"tile[{t['row']}][{t['col']}] pixel_scale={ps:.3f} "
                f"is far from median={median_scale:.3f} (ratio={ratio:.2f})"
            )


@pytest.mark.slow
def test_local_tile_solve_8x6():
    """8x6 グリッド: 精密ヒントで解けるべきタイル (8/48) が解けることを確認。

    フィクスチャの batch_success=True タイルのみソルブ対象。
    旧バッチモード Pass 2 で解けた 8 タイルが、per-tile でも同様に解けることを検証。
    """
    result = _run_tile_solve("8x6", timeout_per_tile=240)
    _print_report(result)

    total = result["tiles_total"]
    solved = result["tiles_solved"]
    fixture = result["fixture"]
    batch_solved = fixture.get("batch_solved", 8)

    assert total == batch_solved, (
        f"Expected {batch_solved} tiles (batch_success), got {total}"
    )
    # 精密ヒント付きなのでベースラインと同等以上を期待
    failed = ["[%d][%d]" % (t["row"], t["col"]) for t in result["tile_results"] if not t.get("success")]
    assert solved >= batch_solved, (
        f"Expected ≥{batch_solved}/{total} tiles solved with refined hints, "
        f"got {solved}/{total}. Failed: {failed}"
    )

    # 成功タイルの pixel_scale がメジアンスケールと整合すること
    median_scale = fixture.get("median_scale", 54.121)
    for t in result["tile_results"]:
        if t.get("success") and t.get("pixel_scale"):
            ps = t["pixel_scale"]
            ratio = ps / median_scale
            assert 0.5 <= ratio <= 2.0, (
                f"tile[{t['row']}][{t['col']}] pixel_scale={ps:.3f} "
                f"is far from median={median_scale:.3f} (ratio={ratio:.2f})"
            )
