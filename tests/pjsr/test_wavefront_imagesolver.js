// test_wavefront_imagesolver.js
// ImageSolver を使った wavefront グリッド E2E テスト（2x2）
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/2x2/ に tile FITS が存在すること
//
// テスト戦略:
//   UI依存の doSplitSolveCore は使わず、スタンドアロン関数を直接呼ぶ:
//     buildTilesFromFixture → computeTileHints → solveWavefront → mergeWcsSolutions
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_imagesolver.js

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
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_wavefront_imagesolver_result.json";

// ============================================================
// フィクスチャ・設定
// ============================================================
var FIXTURE_PATH     = PROJECT_ROOT + "tests/fixtures/tile_hints_local_2x2.json";
var TILE_DIR         = PROJECT_ROOT + "tests/fits_downsampling/2x2";
var BASELINE_MIN_SOLVED = 4;  // tile_hints_local_2x2.json の batch_solved に基づく

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: フィクスチャが見つかりません: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

var fixtureJson = File.readTextFile(FIXTURE_PATH);
var fixture = JSON.parse(fixtureJson);

// ============================================================
// ヘルパー: フィクスチャからタイル配列を構築
// ============================================================
function buildTilesFromFixture(fx, tileDir) {
    var tiles = [];
    for (var i = 0; i < fx.tiles.length; i++) {
        var t = fx.tiles[i];
        tiles.push({
            filePath:       tileDir + "/tile_" + t.col + "_" + t.row + ".fits",
            col:            t.col,
            row:            t.row,
            offsetX:        t.offset_x,
            offsetY:        t.offset_y,
            tileWidth:      t.tile_width,
            tileHeight:     t.tile_height,
            scaleFactor:    1.0,
            origOffsetX:    t.offset_x,
            origOffsetY:    t.offset_y,
            origTileWidth:  t.tile_width,
            origTileHeight: t.tile_height,
            hintRA:         t.ra_hint,
            hintDEC:        t.dec_hint,
            wcs:            null,
            calibration:    null,
            status:         "pending"
        });
    }
    return tiles;
}

// ============================================================
// wavefront を実行（一度だけ）して結果をキャッシュ
// ============================================================
var _wavefrontResult = null;

function getWavefrontResult() {
    if (_wavefrontResult !== null) { return _wavefrontResult; }

    var tiles = buildTilesFromFixture(fixture, TILE_DIR);
    var hints = fixture.hints;

    // computeTileHints でヒントを付与（フィクスチャ値で上書きされるが一応実行）
    computeTileHints(
        tiles,
        hints.centerRA, hints.centerDEC,
        hints.scaleEst,
        fixture.imageWidth, fixture.imageHeight,
        hints.projection
    );
    // フィクスチャのヒントで上書き
    for (var i = 0; i < tiles.length; i++) {
        for (var j = 0; j < fixture.tiles.length; j++) {
            if (fixture.tiles[j].col === tiles[i].col && fixture.tiles[j].row === tiles[i].row) {
                tiles[i].hintRA  = fixture.tiles[j].ra_hint;
                tiles[i].hintDEC = fixture.tiles[j].dec_hint;
                break;
            }
        }
    }

    solveWavefront(
        null,             // client (IS モードでは不使用)
        tiles,
        hints,
        fixture.imageWidth,
        fixture.imageHeight,
        2, 2,             // gridX, gridY
        null,             // progressCallback
        solveSingleTileIS, // tileSolverFn
        function() { return false; }, // abortCheckFn
        null,             // skipCheckFn
        0                 // rateLimitMs
    );

    var merged = mergeWcsSolutions(tiles, fixture.imageWidth, fixture.imageHeight);

    _wavefrontResult = {
        tiles:  tiles,
        merged: merged
    };
    return _wavefrontResult;
}

// ============================================================
// テスト
// ============================================================

test("wavefront 2x2 で成功タイル数 >= ベースライン(" + BASELINE_MIN_SOLVED + ")", function() {
    var r = getWavefrontResult();
    var solved = 0;
    for (var i = 0; i < r.tiles.length; i++) {
        if (r.tiles[i].status === "success") solved++;
    }
    console.writeln("  solved=" + solved + " / " + r.tiles.length);
    assertTrue(solved >= BASELINE_MIN_SOLVED,
        "成功タイル数=" + solved + " がベースライン=" + BASELINE_MIN_SOLVED + " 以上であること");
});

test("mergeWcsSolutions が非null の WCS 結果を返す", function() {
    var r = getWavefrontResult();
    assertTrue(r.merged !== null, "mergeWcsSolutions の結果が null でないこと");
    assertTrue(r.merged.controlPoints !== undefined, "controlPoints が存在すること");
});

test("WCS RMS が 100arcsec 未満", function() {
    var r = getWavefrontResult();
    assertTrue(r.merged !== null, "mergeWcsSolutions の結果が null でないこと");
    // rms が存在する場合のみ検証（計算されない実装の場合はスキップ）
    if (typeof r.merged.rmsArcsec === "number") {
        assertTrue(r.merged.rmsArcsec < 100,
            "WCS RMS=" + r.merged.rmsArcsec.toFixed(2) + "arcsec が 100arcsec 未満であること");
    } else {
        console.writeln("  NOTE: rmsArcsec が未定義のためスキップ");
    }
});

// ============================================================
// 実行
// ============================================================
runAllTests(RESULT_PATH);
