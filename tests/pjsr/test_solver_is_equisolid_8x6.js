// test_solver_is_equisolid_8x6.js
// solveSingleTileIS の PJSR インテグレーションテスト (8x6, Sigma 15mm equisolid fisheye)
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/equisolid_8x6/ に tile FITS が存在すること
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_solver_is_equisolid_8x6.js
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
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_solver_is_equisolid_8x6_result.json";

// ============================================================
// フィクスチャ読み込み
// ============================================================
var FIXTURE_PATH = PROJECT_ROOT + "tests/fixtures/tile_hints_local_equisolid_8x6.json";
var TILE_DIR     = PROJECT_ROOT + "tests/fits_downsampling/equisolid_8x6";

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
var tileR2C3Fixture = findTileFixture(3, 2); // row=2, col=3 (中心付近)
var tileR2C4Fixture = findTileFixture(4, 2); // row=2, col=4 (中心付近)
var tileR1C3Fixture = findTileFixture(3, 1); // row=1, col=3

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
// equisolid 投影ではタイルごとに局所スケールが異なるため中点を採用
function effectiveTileScale(fx) {
    var maxEdge = Math.max(fx.tile_width, fx.tile_height);
    var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
    var mid = (fx.scale_lower + fx.scale_upper) / 2.0;
    return mid / sf;
}

// ============================================================
// テスト: tile[2,3] (row=2, col=3)
// ============================================================

test("tile[2,3] のソルブが true を返す", function() {
    if (!tileR2C3Fixture) { throw new Error("tile[2,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 2, fp, tileR2C3Fixture);
    var tileHints = {
        center_ra:  tileR2C3Fixture.ra_hint,
        center_dec: tileR2C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C3Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[2,3] ソルブが true を返すこと");
});

test("tile[2,3] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR2C3Fixture) { throw new Error("tile[2,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 2, fp, tileR2C3Fixture);
    var tileHints = {
        center_ra:  tileR2C3Fixture.ra_hint,
        center_dec: tileR2C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C3Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[2,3] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[2,3] tile.status が success");
});

test("tile[2,3] 解RA が ra_hint から5度以内", function() {
    if (!tileR2C3Fixture) { throw new Error("tile[2,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 2, fp, tileR2C3Fixture);
    var tileHints = {
        center_ra:  tileR2C3Fixture.ra_hint,
        center_dec: tileR2C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C3Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[2,3] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR2C3Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[2,3] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// 共通テスト（tile[2,3] を使用）
// ============================================================

test("存在しないファイルパスで false を返す", function() {
    if (!tileR2C3Fixture) { throw new Error("tile[2,3] フィクスチャが見つかりません"); }
    var tile = makeTileObject(3, 2, "/nonexistent/path/tile.fits", tileR2C3Fixture);
    var tileHints = {
        center_ra:  tileR2C3Fixture.ra_hint,
        center_dec: tileR2C3Fixture.dec_hint
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertFalse(result, "存在しないFITSでfalseを返すこと");
    assertEqual(tile.status, "failed", "tile.status が failed");
});

test("coordThreshDeg=1.0 + 遠方座標で偽陽性フィルタが拒否する", function() {
    if (!tileR2C3Fixture) { throw new Error("tile[2,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 2, fp, tileR2C3Fixture);
    var tileHints = {
        center_ra:  tileR2C3Fixture.ra_hint,
        center_dec: tileR2C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C3Fixture)
    };
    var farExpected = [tileR2C3Fixture.ra_hint, tileR2C3Fixture.dec_hint + 30.0];
    var result = solveSingleTileIS(tile, tileHints, null, farExpected, 1.0);
    assertFalse(result, "遠方座標では偽陽性フィルタにより拒否されること");
});

// ============================================================
// テスト: tile[2,4] (row=2, col=4)
// ============================================================

test("tile[2,4] のソルブが true を返す", function() {
    if (!tileR2C4Fixture) { throw new Error("tile[2,4] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_4.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(4, 2, fp, tileR2C4Fixture);
    var tileHints = {
        center_ra:  tileR2C4Fixture.ra_hint,
        center_dec: tileR2C4Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C4Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[2,4] ソルブが true を返すこと");
});

test("tile[2,4] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR2C4Fixture) { throw new Error("tile[2,4] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_4.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(4, 2, fp, tileR2C4Fixture);
    var tileHints = {
        center_ra:  tileR2C4Fixture.ra_hint,
        center_dec: tileR2C4Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C4Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[2,4] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[2,4] tile.status が success");
});

test("tile[2,4] 解RA が ra_hint から5度以内", function() {
    if (!tileR2C4Fixture) { throw new Error("tile[2,4] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_2_4.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(4, 2, fp, tileR2C4Fixture);
    var tileHints = {
        center_ra:  tileR2C4Fixture.ra_hint,
        center_dec: tileR2C4Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR2C4Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[2,4] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR2C4Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[2,4] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// テスト: tile[1,3] (row=1, col=3)
// ============================================================

test("tile[1,3] のソルブが true を返す", function() {
    if (!tileR1C3Fixture) { throw new Error("tile[1,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_1_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 1, fp, tileR1C3Fixture);
    var tileHints = {
        center_ra:  tileR1C3Fixture.ra_hint,
        center_dec: tileR1C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR1C3Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "tile[1,3] ソルブが true を返すこと");
});

test("tile[1,3] ソルブ成功時に tile.wcs が設定される", function() {
    if (!tileR1C3Fixture) { throw new Error("tile[1,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_1_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 1, fp, tileR1C3Fixture);
    var tileHints = {
        center_ra:  tileR1C3Fixture.ra_hint,
        center_dec: tileR1C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR1C3Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[1,3] tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile[1,3] tile.status が success");
});

test("tile[1,3] 解RA が ra_hint から5度以内", function() {
    if (!tileR1C3Fixture) { throw new Error("tile[1,3] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_1_3.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(3, 1, fp, tileR1C3Fixture);
    var tileHints = {
        center_ra:  tileR1C3Fixture.ra_hint,
        center_dec: tileR1C3Fixture.dec_hint,
        scale_est:  effectiveTileScale(tileR1C3Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile[1,3] WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tileR1C3Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "tile[1,3] 解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

// ============================================================
// 実行
// ============================================================
runAllTests(RESULT_PATH);
