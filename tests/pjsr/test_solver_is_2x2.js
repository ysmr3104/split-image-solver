// test_solver_is_2x2.js
// IT-Solver IS (2x2, 50mm rectilinear)
//
// IS wavefront で解けたタイルに対して IS 実解座標 (IS_CRVAL) をヒントとして
// solveSingleTileIS を per-tile で実行し、全件解けることを確認する。
// (tests/it/local/test_solver_2x2.py の IS 版)
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/2x2/ に tile FITS が存在すること
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_solver_is_2x2.js

var __SPLIT_SOLVER_LIBRARY_MODE = true;

#include <pjsr/UndoFlag.jsh>
#include <pjsr/ImageOp.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/StdCursor.jsh>

#define USE_SOLVER_LIBRARY
#include "/Applications/PixInsight/src/scripts/AdP/ImageSolver.js"

#include "../../javascript/SplitImageSolver.js"
#include "pjsr_test_framework.js"

var PROJECT_ROOT = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__) + "/../../";
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_solver_is_2x2_result.json";

var FIXTURE_PATH = PROJECT_ROOT + "tests/fixtures/tile_hints_local_2x2.json";
var TILE_DIR     = PROJECT_ROOT + "tests/fits_downsampling/2x2";

// IS wavefront 実解座標 (2026-03-20)
// Local solver (solve-field) baseline: 4/4
var IS_CRVAL = {
    "0_0": { ra: 93.002298, dec:  6.031430 },
    "0_1": { ra: 73.921903, dec:  6.253048 },
    "1_0": { ra: 92.856549, dec: -6.325288 },
    "1_1": { ra: 73.771563, dec: -6.106851 }
};

var BASELINE_MIN_SOLVED = 4;

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: fixture not found: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

var fixture = JSON.parse(File.readTextFile(FIXTURE_PATH));

// ============================================================
// Helper: find fixture tile entry by row/col
// ============================================================
function _findFixtureTile(fx, row, col) {
    for (var i = 0; i < fx.tiles.length; i++) {
        if (fx.tiles[i].row === row && fx.tiles[i].col === col) { return fx.tiles[i]; }
    }
    return null;
}

// ============================================================
// Helper: build tile objects from IS_CRVAL entries
// ============================================================
function _buildTileRequests(fx, tileDir) {
    var requests = [];
    var keys = Object.keys(IS_CRVAL);
    for (var k = 0; k < keys.length; k++) {
        var key   = keys[k];
        var parts = key.split("_");
        var row   = parseInt(parts[0], 10);
        var col   = parseInt(parts[1], 10);
        var ft    = _findFixtureTile(fx, row, col);
        var filePath = tileDir + "/tile_" + row + "_" + col + ".fits";
        if (!File.exists(filePath)) { continue; }
        var maxEdge = ft ? Math.max(ft.tile_width, ft.tile_height) : 2000;
        var sf      = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
        var scaleEst = ft ? (ft.scale_lower + ft.scale_upper) / 2.0 / sf
                          : fx.hints.scaleEst / sf;
        requests.push({
            tile: {
                filePath:       filePath,
                col:            col,
                row:            row,
                offsetX:        ft ? ft.offset_x : 0,
                offsetY:        ft ? ft.offset_y : 0,
                tileWidth:      ft ? ft.tile_width  : 0,
                tileHeight:     ft ? ft.tile_height : 0,
                scaleFactor:    sf,
                origOffsetX:    ft ? ft.offset_x : 0,
                origOffsetY:    ft ? ft.offset_y : 0,
                origTileWidth:  ft ? ft.tile_width  : 0,
                origTileHeight: ft ? ft.tile_height : 0,
                wcs:            null,
                calibration:    null,
                status:         "pending"
            },
            hints: {
                center_ra:  IS_CRVAL[key].ra,
                center_dec: IS_CRVAL[key].dec,
                scale_est:  scaleEst
            },
            row: row,
            col: col
        });
    }
    return requests;
}

// ============================================================
// Helper: run solveSingleTileIS for all IS_CRVAL tiles
// ============================================================
function _runTileSolve(fx, tileDir) {
    var requests = _buildTileRequests(fx, tileDir);
    var tileResults = [];
    for (var i = 0; i < requests.length; i++) {
        var req = requests[i];
        var ok = solveSingleTileIS(req.tile, req.hints, null, null, null);
        var entry = { row: req.row, col: req.col, success: ok };
        if (ok && req.tile.wcs) {
            entry.crval1 = req.tile.wcs.crval1;
            entry.crval2 = req.tile.wcs.crval2;
        }
        tileResults.push(entry);
    }
    var solved = 0;
    for (var j = 0; j < tileResults.length; j++) {
        if (tileResults[j].success) { solved++; }
    }
    var ret = { tilesTotal: requests.length, tilesSolved: solved, tileResults: tileResults };
    var tf = new File(); tf.createForWriting(PROJECT_ROOT + "tests/pjsr/results/test_solver_is_2x2_tiles.json");
    tf.outText(JSON.stringify(ret, null, 2)); tf.close();
    return ret;
}

// ============================================================
// Helper: print per-tile results
// ============================================================
function _printReport(result, mode) {
    console.writeln("");
    console.writeln("============================================================");
    console.writeln("IS Tile Solve: " + mode + "  " + result.tilesSolved + "/" + result.tilesTotal + " solved");
    console.writeln("============================================================");
    for (var i = 0; i < result.tileResults.length; i++) {
        var t = result.tileResults[i];
        if (t.success) {
            console.writeln("  [" + t.row + "][" + t.col + "] OK   RA=" + t.crval1.toFixed(3) + "  DEC=" + t.crval2.toFixed(3));
        } else {
            console.writeln("  [" + t.row + "][" + t.col + "] FAIL");
        }
    }
    console.writeln("============================================================");
}

// ============================================================
// Test
// ============================================================
test("IS Tile Solve 2x2: IS_CRVAL tiles solved >= " + BASELINE_MIN_SOLVED, function() {
    var result = _runTileSolve(fixture, TILE_DIR);
    _printReport(result, "2x2");

    var solved = result.tilesSolved;
    var total  = result.tilesTotal;
    assertTrue(
        solved >= BASELINE_MIN_SOLVED,
        "solved=" + solved + "/" + total + " must be >= baseline=" + BASELINE_MIN_SOLVED
    );
});

runAllTests(RESULT_PATH);
