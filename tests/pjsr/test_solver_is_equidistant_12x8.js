// test_solver_is_equidistant_12x8.js
// IT-Solver IS (12x8, AstrHori 6.5mm equidistant fisheye)
//
// IS wavefront で解けたタイルに対して IS 実解座標 (IS_CRVAL) をヒントとして
// solveSingleTileIS を per-tile で実行し、全件解けることを確認する。
// (tests/it/local/test_solver_equidistant_12x8.py の IS 版)
//
// 前提:
//   - PixInsight に AdP ImageSolver がインストールされていること
//   - tests/fits_downsampling/equidistant_12x8/ に tile FITS が存在すること
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_solver_is_equidistant_12x8.js

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
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_solver_is_equidistant_12x8_result.json";

var FIXTURE_PATH = PROJECT_ROOT + "tests/fixtures/tile_hints_local_equidistant_12x8.json";
var TILE_DIR     = PROJECT_ROOT + "tests/fits_downsampling/equidistant_12x8";

// IS wavefront 実解座標 (2026-03-20)
// Local solver (solve-field) baseline: 12/12
var IS_CRVAL = {
    "2_5": { ra:  18.273255, dec:   8.433049 },
    "3_4": { ra: 357.949690, dec:  22.837896 },
    "3_5": { ra:  17.158741, dec:  26.301159 },
    "4_4": { ra: 351.643768, dec:  39.060940 },
    "4_5": { ra:  14.715765, dec:  43.496033 },
    "4_6": { ra:  38.683573, dec:  43.593308 },
    "4_7": { ra:  61.733792, dec:  39.420995 },
    "5_4": { ra: 337.728981, dec:  54.071931 },
    "5_5": { ra:   8.582641, dec:  60.955449 },
    "5_6": { ra:  44.304575, dec:  61.130794 }
};

var BASELINE_MIN_SOLVED = 10;

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
    var tf = new File(); tf.createForWriting(PROJECT_ROOT + "tests/pjsr/results/test_solver_is_equidistant_12x8_tiles.json");
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
test("IS Tile Solve equidistant_12x8: IS_CRVAL tiles solved >= " + BASELINE_MIN_SOLVED, function() {
    var result = _runTileSolve(fixture, TILE_DIR);
    _printReport(result, "equidistant_12x8");

    var solved = result.tilesSolved;
    var total  = result.tilesTotal;
    assertTrue(
        solved >= BASELINE_MIN_SOLVED,
        "solved=" + solved + "/" + total + " must be >= baseline=" + BASELINE_MIN_SOLVED
    );
});

runAllTests(RESULT_PATH);
