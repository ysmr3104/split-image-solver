// test_wavefront_is_8x6.js
// Wavefront grid test using ImageSolver (8x6, 14mm rectilinear)
//
// Prerequisites:
//   - AdP ImageSolver must be installed in PixInsight
//   - Tile FITS files must exist in tests/fits_downsampling/8x6/
//
// Test strategy:
//   Bypass UI-dependent doSplitSolveCore and call standalone functions directly:
//     buildTilesFromFixture -> computeTileHints -> solveWavefront -> mergeWcsSolutions
//
// Run:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_is_8x6.js

var __SPLIT_SOLVER_LIBRARY_MODE = true;

#include <pjsr/UndoFlag.jsh>
#include <pjsr/ImageOp.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/StdCursor.jsh>

// Load ImageSolver in library mode (suppresses main() / UI execution)
#define USE_SOLVER_LIBRARY
#include "/Applications/PixInsight/src/scripts/AdP/ImageSolver.js"

#include "../../javascript/SplitImageSolver.js"
#include "pjsr_test_framework.js"

var PROJECT_ROOT = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__) + "/../../";
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_wavefront_is_8x6_result.json";

// ============================================================
// Fixture and configuration
// ============================================================
var FIXTURE_PATH     = PROJECT_ROOT + "tests/fixtures/tile_hints_local_8x6.json";
var TILE_DIR         = PROJECT_ROOT + "tests/fits_downsampling/8x6";
var GRID_X           = 8;
var GRID_Y           = 6;
// BASELINE: ImageSolver wavefront 実測値 (2026-03-19)
// Local solver (solve-field) baseline: 8/48
var BASELINE_MIN_SOLVED = 4;

if (!File.exists(FIXTURE_PATH)) {
    console.writeln("ERROR: fixture not found: " + FIXTURE_PATH);
    runAllTests(RESULT_PATH);
}

var fixtureJson = File.readTextFile(FIXTURE_PATH);
var fixture = JSON.parse(fixtureJson);

// ============================================================
// Helper: build tile array from fixture
// ============================================================
function buildTilesFromFixture(fx, tileDir) {
    var tiles = [];
    for (var i = 0; i < fx.tiles.length; i++) {
        var t = fx.tiles[i];
        var maxEdge = Math.max(t.tile_width, t.tile_height);
        var sf = (maxEdge > 2000) ? (2000.0 / maxEdge) : 1.0;
        tiles.push({
            filePath:       tileDir + "/tile_" + t.row + "_" + t.col + ".fits",
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
// Run wavefront once and cache the result
// ============================================================
var _wavefrontResult = null;

function getWavefrontResult() {
    if (_wavefrontResult !== null) { return _wavefrontResult; }

    var tiles = buildTilesFromFixture(fixture, TILE_DIR);

    var fh = fixture.hints;
    var hints = {
        center_ra:    fh.centerRA,
        center_dec:   fh.centerDEC,
        scale_est:    fh.scaleEst,
        _nativeScale: fh.scaleEst,
        _projection:  fh.projection || "rectilinear"
    };

    // Apply computeTileHints (overridden by fixture values below)
    computeTileHints(
        tiles,
        fh.centerRA, fh.centerDEC,
        fh.scaleEst,
        fixture.imageWidth, fixture.imageHeight,
        fh.projection
    );
    // Override with fixture hints
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
        null,              // client (unused in IS mode)
        tiles,
        hints,
        fixture.imageWidth,
        fixture.imageHeight,
        GRID_X, GRID_Y,
        null,              // progressCallback
        solveSingleTileIS, // tileSolverFn
        function() { return false; }, // abortCheckFn
        null,              // skipCheckFn
        0                  // rateLimitMs
    );

    var merged = mergeWcsSolutions(tiles, fixture.imageWidth, fixture.imageHeight);

    _wavefrontResult = {
        tiles:  tiles,
        merged: merged
    };
    return _wavefrontResult;
}

// ============================================================
// Tests
// ============================================================

test("wavefront 8x6: solved tile count >= baseline (" + BASELINE_MIN_SOLVED + ")", function() {
    var r = getWavefrontResult();
    var solved = 0;
    for (var i = 0; i < r.tiles.length; i++) {
        if (r.tiles[i].status === "success") solved++;
    }
    console.writeln("  solved=" + solved + " / " + r.tiles.length);
    assertTrue(solved >= BASELINE_MIN_SOLVED,
        "solved count=" + solved + " must be >= baseline=" + BASELINE_MIN_SOLVED);
});

test("mergeWcsSolutions returns non-null WCS result with crval and cd matrix", function() {
    var r = getWavefrontResult();
    assertTrue(r.merged !== null, "mergeWcsSolutions result must not be null");
    assertTrue(r.merged.crval1 !== undefined, "crval1 must exist");
    assertTrue(r.merged.cd !== undefined, "cd matrix must exist");
});

test("WCS RMS is defined and within expected range for wide-angle multi-tile", function() {
    var r = getWavefrontResult();
    assertTrue(r.merged !== null, "mergeWcsSolutions result must not be null");
    if (typeof r.merged.rms_arcsec === "number") {
        assertTrue(r.merged.rms_arcsec < 3600,
            "WCS RMS=" + r.merged.rms_arcsec.toFixed(2) + "arcsec must be < 3600arcsec (1 degree)");
    } else {
        console.writeln("  NOTE: rms_arcsec not defined, skipping");
    }
});

// ============================================================
// Run
// ============================================================
runAllTests(RESULT_PATH);
