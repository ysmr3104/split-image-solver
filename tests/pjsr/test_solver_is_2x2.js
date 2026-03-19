// test_solver_is_2x2.js
// IT-Solver IS (2x2, 50mm rectilinear)
//
// Fixture の batch_success タイルに対して solveSingleTileIS を per-tile で実行し
// 解けたタイル数を検証する（tests/it/local/test_solver_2x2.py の IS 版）
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

// BASELINE: IS 実測値
// Local solver (solve-field) baseline: 4/4
var BASELINE_MIN_SOLVED = 3;

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: fixture not found: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

var fixture = JSON.parse(File.readTextFile(FIXTURE_PATH));

// ============================================================
// Helper: build tile objects for batch_success tiles
// ============================================================
function _buildTileRequests(fx, tileDir) {
    var requests = [];
    for (var i = 0; i < fx.tiles.length; i++) {
        var t = fx.tiles[i];
        if (!t.batch_success) { continue; }
        var filePath = tileDir + "/tile_" + t.row + "_" + t.col + ".fits";
        if (!File.exists(filePath)) { continue; }
        var maxEdge = Math.max(t.tile_width, t.tile_height);
        var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
        requests.push({
            tile: {
                filePath:       filePath,
                col:            t.col,
                row:            t.row,
                offsetX:        t.offset_x,
                offsetY:        t.offset_y,
                tileWidth:      t.tile_width,
                tileHeight:     t.tile_height,
                scaleFactor:    sf,
                origOffsetX:    t.offset_x,
                origOffsetY:    t.offset_y,
                origTileWidth:  t.tile_width,
                origTileHeight: t.tile_height,
                wcs:            null,
                calibration:    null,
                status:         "pending"
            },
            hints: {
                center_ra:  t.ra_hint,
                center_dec: t.dec_hint,
                scale_est:  (t.scale_lower + t.scale_upper) / 2.0 / sf
            },
            row: t.row,
            col: t.col
        });
    }
    return requests;
}

// ============================================================
// Helper: run solveSingleTileIS for all batch_success tiles
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
    return { tilesTotal: requests.length, tilesSolved: solved, tileResults: tileResults };
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
test("IS Tile Solve 2x2: batch_success tiles solved >= " + BASELINE_MIN_SOLVED, function() {
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
