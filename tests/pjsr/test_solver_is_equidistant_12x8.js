// test_solver_is_equidistant_12x8.js
// solveSingleTileIS の PJSR インテグレーションテスト (12x8, AstrHori 6.5mm equidistant fisheye)
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/equidistant_12x8/ に tile FITS が存在すること
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_solver_is_equidistant_12x8.js
//
// ※ ImageSolver ソルブは時間がかかるため手動実行専用

var __SPLIT_SOLVER_LIBRARY_MODE = true;

#include <pjsr/UndoFlag.jsh>
#include <pjsr/ImageOp.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/StdCursor.jsh>

// ImageSolver をライブラリモードで読み込む（main() / UI の実行を抑制）
#define USE_SOLVER_LIBRARY
#include "/Applications/PixInsight/src/scripts/AdP/ImageSolver.js"

#include "../../javascript/SplitImageSolver.js"
#include "pjsr_test_framework.js"

var PROJECT_ROOT = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__) + "/../../";
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_solver_is_equidistant_12x8_result.json";

// ============================================================
// フィクスチャ読み込み
// ============================================================
var FIXTURE_PATH = PROJECT_ROOT + "tests/fixtures/tile_hints_local_equidistant_12x8.json";
var TILE_DIR     = PROJECT_ROOT + "tests/fits_downsampling/equidistant_12x8";

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: フィクスチャが見つかりません: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

var fixtureJson = File.readTextFile(FIXTURE_PATH);
var fixture = JSON.parse(fixtureJson);

// フィクスチャから指定タイルを取得するヘルパー
function findTileFixture(col, row) {
    for (var fi = 0; fi < fixture.tiles.length; fi++) {
        if (fixture.tiles[fi].col === col && fixture.tiles[fi].row === row) {
            return fixture.tiles[fi];
        }
    }
    return null;
}

// batch_success=true のタイルからテスト対象を選択
var tileR3C5Fixture = findTileFixture(5, 3); // row=3, col=5 (中心付近)
var tileR3C6Fixture = findTileFixture(6, 3); // row=3, col=6
var tileR4C6Fixture = findTileFixture(6, 4); // row=4, col=6

// ============================================================
// ヘルパー: タイルオブジェクトを生成（scaleFactor を自動計算）
// ============================================================
function makeTileObject(col, row, filePath, fx) {
    var maxEdge = Math.max(fx.tile_width, fx.tile_height);
    var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
    return {
        filePath:        filePath,
        col:             col,
        row:             row,
        offsetX:         fx.offset_x,
        offsetY:         fx.offset_y,
        tileWidth:       fx.tile_width,
        tileHeight:      fx.tile_height,
        scaleFactor:     sf,
        origOffsetX:     fx.offset_x,
        origOffsetY:     fx.offset_y,
        origTileWidth:   fx.tile_width,
        origTileHeight:  fx.tile_height,
        wcs:             null,
        calibration:     null,
        status:          "pending"
    };
}

// タイル固有の scale_lower/scale_upper 中点を実効スケールとして使用
// equidistant 投影ではタイルごとに局所スケールが異なるため中点を採用
function effectiveTileScale(fx) {
    var maxEdge = Math.max(fx.tile_width, fx.tile_height);
    var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
    var mid = (fx.scale_lower + fx.scale_upper) / 2.0;
    return mid / sf;
}

// ============================================================
// テスト: tile[3,5] (row=3, col=5)
// ============================================================

test("tile[3,5] のソルブが true を返す", function() {
    if (!tileR3C5Fixture) { throw new Error("tile[3,5] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_5.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(5, 3, fp, tileR3C5Fixture);
    var tileHints = {
        center_ra:  tileR3C5Fixture.ra_hint,
        center_dec: tileR3C5Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C5Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[3,5] ソルブが true を返すこと");
});

test("tile[3,5] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR3C5Fixture) { throw new Error("tile[3,5] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_5.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(5, 3, fp, tileR3C5Fixture);
    var tileHints = {
        center_ra:  tileR3C5Fixture.ra_hint,
        center_dec: tileR3C5Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C5Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[3,5] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[3,5] tile.status が success");
});

test("tile[3,5] 解RA が ra_hint から5度以内", function() {
    if (!tileR3C5Fixture) { throw new Error("tile[3,5] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_5.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(5, 3, fp, tileR3C5Fixture);
    var tileHints = {
        center_ra:  tileR3C5Fixture.ra_hint,
        center_dec: tileR3C5Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C5Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[3,5] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR3C5Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[3,5] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// 共通テスト（tile[3,5] を使用）
// ============================================================

test("存在しないファイルパスで false を返す", function() {
    if (!tileR3C5Fixture) { throw new Error("tile[3,5] フィクスチャが見つかりません"); }
    var tile = makeTileObject(5, 3, "/nonexistent/path/tile.fits", tileR3C5Fixture);
    var tileHints = {
        center_ra:  tileR3C5Fixture.ra_hint,
        center_dec: tileR3C5Fixture.dec_hint
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertFalse(result, "存在しないFITSでfalseを返すこと");
    assertEqual(tile.status, "failed", "tile.status が failed");
});

test("coordThreshDeg=1.0 + 遠方座標で偽陽性フィルタが拒否する", function() {
    if (!tileR3C5Fixture) { throw new Error("tile[3,5] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_5.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(5, 3, fp, tileR3C5Fixture);
    var tileHints = {
        center_ra:  tileR3C5Fixture.ra_hint,
        center_dec: tileR3C5Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C5Fixture)
    };
    var farExpected = [tileR3C5Fixture.ra_hint, tileR3C5Fixture.dec_hint + 30.0];
    var result = solveSingleTileIS(tile, tileHints, null, farExpected, 1.0);
    assertFalse(result, "遠方座標では偽陽性フィルタにより拒否されること");
});

// ============================================================
// テスト: tile[3,6] (row=3, col=6)
// ============================================================

test("tile[3,6] のソルブが true を返す", function() {
    if (!tileR3C6Fixture) { throw new Error("tile[3,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 3, fp, tileR3C6Fixture);
    var tileHints = {
        center_ra:  tileR3C6Fixture.ra_hint,
        center_dec: tileR3C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C6Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[3,6] ソルブが true を返すこと");
});

test("tile[3,6] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR3C6Fixture) { throw new Error("tile[3,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 3, fp, tileR3C6Fixture);
    var tileHints = {
        center_ra:  tileR3C6Fixture.ra_hint,
        center_dec: tileR3C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C6Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[3,6] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[3,6] tile.status が success");
});

test("tile[3,6] 解RA が ra_hint から5度以内", function() {
    if (!tileR3C6Fixture) { throw new Error("tile[3,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_3_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 3, fp, tileR3C6Fixture);
    var tileHints = {
        center_ra:  tileR3C6Fixture.ra_hint,
        center_dec: tileR3C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR3C6Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[3,6] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR3C6Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[3,6] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// テスト: tile[4,6] (row=4, col=6)
// ============================================================

test("tile[4,6] のソルブが true を返す", function() {
    if (!tileR4C6Fixture) { throw new Error("tile[4,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_4_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 4, fp, tileR4C6Fixture);
    var tileHints = {
        center_ra:  tileR4C6Fixture.ra_hint,
        center_dec: tileR4C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR4C6Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[4,6] ソルブが true を返すこと");
});

test("tile[4,6] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR4C6Fixture) { throw new Error("tile[4,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_4_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 4, fp, tileR4C6Fixture);
    var tileHints = {
        center_ra:  tileR4C6Fixture.ra_hint,
        center_dec: tileR4C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR4C6Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[4,6] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[4,6] tile.status が success");
});

test("tile[4,6] 解RA が ra_hint から5度以内", function() {
    if (!tileR4C6Fixture) { throw new Error("tile[4,6] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_4_6.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(6, 4, fp, tileR4C6Fixture);
    var tileHints = {
        center_ra:  tileR4C6Fixture.ra_hint,
        center_dec: tileR4C6Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR4C6Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[4,6] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR4C6Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[4,6] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// 実行
// ============================================================
runAllTests(RESULT_PATH);
