// test_imagesolver_tile.js
// solveSingleTileIS の PJSR インテグレーションテスト
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/2x2/ に tile FITS が存在すること
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_imagesolver_tile.js
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
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_imagesolver_tile_result.json";

// ============================================================
// フィクスチャ読み込み
// ============================================================
var FIXTURE_PATH = PROJECT_ROOT + "tests/fixtures/tile_hints_local_2x2.json";
var TILE_DIR     = PROJECT_ROOT + "tests/fits_downsampling/2x2";

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: フィクスチャが見つかりません: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

// フィクスチャを読み込む
var fixtureJson = File.readTextFile(FIXTURE_PATH);
var fixture = JSON.parse(fixtureJson);

// tile [col=0, row=0] のフィクスチャを取得
var tile00Fixture = null;
for (var fi = 0; fi < fixture.tiles.length; fi++) {
    if (fixture.tiles[fi].col === 0 && fixture.tiles[fi].row === 0) {
        tile00Fixture = fixture.tiles[fi];
        break;
    }
}

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

// ダウンサンプル後の FITS に対する実効スケール（arcsec/px）を計算する
function effectiveTileScale(fx) {
    var maxEdge = Math.max(fx.tile_width, fx.tile_height);
    var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
    return fixture.hints.scaleEst / sf;
}

// ============================================================
// テスト
// ============================================================

test("tile[0,0] のソルブが true を返す", function() {
    if (!tile00Fixture) { throw new Error("tile[0,0] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_0_0.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(0, 0, fp, tile00Fixture);
    var tileHints = {
        center_ra:  tile00Fixture.ra_hint,
        center_dec: tile00Fixture.dec_hint,
        scale_est:  effectiveTileScale(tile00Fixture)
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(result, "ソルブが true を返すこと");
});

test("ソルブ成功時に tile.wcs が設定される", function() {
    if (!tile00Fixture) { throw new Error("tile[0,0] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_0_0.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(0, 0, fp, tile00Fixture);
    var tileHints = {
        center_ra:  tile00Fixture.ra_hint,
        center_dec: tile00Fixture.dec_hint,
        scale_est:  effectiveTileScale(tile00Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "tile.wcs が設定されること");
    assertEqual(tile.status, "success", "tile.status が success");
});

test("解RA が ra_hint から5度以内", function() {
    if (!tile00Fixture) { throw new Error("tile[0,0] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_0_0.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(0, 0, fp, tile00Fixture);
    var tileHints = {
        center_ra:  tile00Fixture.ra_hint,
        center_dec: tile00Fixture.dec_hint,
        scale_est:  effectiveTileScale(tile00Fixture)
    };
    solveSingleTileIS(tile, tileHints, null, null, null);
    assertTrue(tile.wcs !== null, "WCSが存在すること");
    var raDiff = Math.abs(tile.wcs.crval1 - tile00Fixture.ra_hint);
    if (raDiff > 180) raDiff = 360 - raDiff;
    assertTrue(raDiff < 5.0, "解RA が ra_hint から5度以内 (diff=" + raDiff.toFixed(3) + ")");
});

test("存在しないファイルパスで false を返す", function() {
    if (!tile00Fixture) { throw new Error("tile[0,0] フィクスチャが見つかりません"); }
    var tile = makeTileObject(0, 0, "/nonexistent/path/tile.fits", tile00Fixture);
    var tileHints = {
        center_ra:  tile00Fixture.ra_hint,
        center_dec: tile00Fixture.dec_hint
    };
    var result = solveSingleTileIS(tile, tileHints, null, null, null);
    assertFalse(result, "存在しないFITSでfalseを返すこと");
    assertEqual(tile.status, "failed", "tile.status が failed");
});

test("coordThreshDeg=1.0 + 遠方座標で偽陽性フィルタが拒否する", function() {
    if (!tile00Fixture) { throw new Error("tile[0,0] フィクスチャが見つかりません"); }
    var fp = TILE_DIR + "/tile_0_0.fits";
    if (!File.exists(fp)) { throw new Error("FITS が見つかりません: " + fp); }

    var tile = makeTileObject(0, 0, fp, tile00Fixture);
    var tileHints = {
        center_ra:  tile00Fixture.ra_hint,
        center_dec: tile00Fixture.dec_hint,
        scale_est:  effectiveTileScale(tile00Fixture)
    };
    // 遠方の期待座標（+30度ずらし） + 厳しい閾値1度 → 偽陽性フィルタで拒否
    var farExpected = {
        ra:  tile00Fixture.ra_hint,
        dec: tile00Fixture.dec_hint + 30.0
    };
    var result = solveSingleTileIS(tile, tileHints, null, farExpected, 1.0);
    assertFalse(result, "遠方座標では偽陽性フィルタにより拒否されること");
});

// ============================================================
// 実行
// ============================================================
runAllTests(RESULT_PATH);
