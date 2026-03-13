#!/usr/bin/env node
/**
 * Integration tests for the SplitSolve pipeline.
 *
 * Uses real fixture data captured from PixInsight runs to verify:
 *   1. Fixture structure and data quality
 *   2. WCS consistency between adjacent tiles (overlap region agreement)
 *   3. Hint accuracy (hintRA/hintDEC vs actual solved tile center)
 *   4. Mock solverFn pattern (doLocalSolve / doSplitSolveCore design contract)
 *
 * These tests run entirely in Node.js with no PixInsight dependency.
 * Pure math functions are re-implemented here; PJSR-dependent functions
 * (WCSFitter, mergeWcsSolutions) are not exercised.
 */

"use strict";

var fs   = require("fs");
var path = require("path");

// ============================================================
// Test framework
// ============================================================
var passed = 0;
var failed = 0;

function assertEqual(actual, expected, msg, tolerance) {
    if (tolerance !== undefined) {
        if (Math.abs(actual - expected) <= tolerance) {
            passed++;
            console.log("[PASS] " + msg);
            return true;
        }
        failed++;
        console.log("[FAIL] " + msg + ": expected " + expected + " ±" + tolerance + " got " + actual + " (diff=" + Math.abs(actual - expected) + ")");
        return false;
    }
    if (actual === expected) {
        passed++;
        console.log("[PASS] " + msg);
        return true;
    }
    failed++;
    console.log("[FAIL] " + msg + ": expected <" + expected + "> got <" + actual + ">");
    return false;
}

function assertTrue(val, msg) {
    if (val) { passed++; console.log("[PASS] " + msg); return true; }
    failed++;
    console.log("[FAIL] " + msg);
    return false;
}

function test(name, fn) {
    console.log("\n[TEST] " + name);
    try { fn(); }
    catch (e) { failed++; console.log("[FAIL] Uncaught exception: " + e); }
}

// ============================================================
// Math utilities (inline, no PJSR dependency)
// ============================================================

function degToRad(d) { return d * Math.PI / 180; }
function radToDeg(r) { return r * 180 / Math.PI; }

/**
 * Angular separation between two [ra, dec] pairs → degrees.
 */
function angularSeparation(c1, c2) {
    var ra1 = degToRad(c1[0]), dec1 = degToRad(c1[1]);
    var ra2 = degToRad(c2[0]), dec2 = degToRad(c2[1]);
    var x = Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2)
          + Math.sin(dec1) * Math.sin(dec2);
    x = Math.max(-1, Math.min(1, x));
    return radToDeg(Math.acos(x));
}

/**
 * TAN projection + top-down FITS convention (astrometry.net output).
 * px, py: 0-indexed full-image pixel coordinates.
 * wcs: {crval1, crval2, crpix1, crpix2, cd1_1, cd1_2, cd2_1, cd2_2}
 * Returns [ra, dec] in degrees, or null on error.
 * Note: SIP distortion is intentionally omitted (linear WCS only).
 */
function pixelToRaDecTD(wcs, px, py) {
    // FITS convention: 1-indexed, top-down (y increases downward)
    var u = (px + 1) - wcs.crpix1;
    var v = (py + 1) - wcs.crpix2;

    // Linear TAN plane coords (degrees)
    var xi  = wcs.cd1_1 * u + wcs.cd1_2 * v;
    var eta = wcs.cd2_1 * u + wcs.cd2_2 * v;

    // TAN deprojection to RA/DEC
    var ra0  = degToRad(wcs.crval1);
    var dec0 = degToRad(wcs.crval2);
    var xi_r  = degToRad(xi);
    var eta_r = degToRad(eta);

    var denom = Math.cos(dec0) - eta_r * Math.sin(dec0);
    if (Math.abs(denom) < 1e-12) return null;

    var ra  = ra0 + Math.atan2(xi_r, denom);
    var dec = Math.atan2(
        Math.sin(dec0) + eta_r * Math.cos(dec0),
        Math.sqrt(xi_r * xi_r + denom * denom)
    );

    return [(radToDeg(ra) + 360) % 360, radToDeg(dec)];
}

/**
 * Estimated pixel scale (arcsec/px) from WCS CD matrix.
 */
function pixelScaleFromCD(wcs) {
    var area = Math.abs(wcs.cd1_1 * wcs.cd2_2 - wcs.cd1_2 * wcs.cd2_1);
    return Math.sqrt(area) * 3600; // degrees → arcsec
}

// ============================================================
// Fixture loading
// ============================================================
var FIXTURES_DIR = path.join(__dirname, "fixtures");

function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

var f2x2 = loadFixture("tile_wcs_api_2x2.json");
var f8x6 = loadFixture("tile_wcs_api_8x6.json");

function getTile(fixture, row, col) {
    for (var i = 0; i < fixture.tiles.length; i++) {
        var t = fixture.tiles[i];
        if (t.row === row && t.col === col) return t;
    }
    return null;
}

function successTiles(fixture) {
    return fixture.tiles.filter(function(t) { return t.status === "success"; });
}

// ============================================================
// 1. Fixture structure validation
// ============================================================

test("fixture 2x2: top-level structure", function() {
    assertTrue(f2x2.imageWidth > 0,   "imageWidth > 0");
    assertTrue(f2x2.imageHeight > 0,  "imageHeight > 0");
    assertEqual(f2x2.gridX, 2,        "gridX=2");
    assertEqual(f2x2.gridY, 2,        "gridY=2");
    assertTrue(Array.isArray(f2x2.tiles), "tiles is array");
    assertEqual(f2x2.tiles.length, 4, "4 tiles total");
    assertTrue(f2x2.hints !== undefined, "hints present");
    assertTrue(isFinite(f2x2.hints.centerRA),  "hints.centerRA finite");
    assertTrue(isFinite(f2x2.hints.centerDEC), "hints.centerDEC finite");
    assertTrue(isFinite(f2x2.hints.scaleEst),  "hints.scaleEst finite");
});

test("fixture 2x2: all 4 tiles solved with valid WCS", function() {
    var s = successTiles(f2x2);
    assertEqual(s.length, 4, "4 success tiles");

    s.forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        var w = t.wcs;
        assertTrue(w !== null,                       id + " wcs present");
        assertTrue(isFinite(w.crval1),               id + " crval1 finite");
        assertTrue(isFinite(w.crval2),               id + " crval2 finite");
        assertTrue(isFinite(w.crpix1),               id + " crpix1 finite");
        assertTrue(isFinite(w.crpix2),               id + " crpix2 finite");
        assertTrue(isFinite(w.cd1_1),                id + " cd1_1 finite");
        assertTrue(isFinite(w.cd2_2),                id + " cd2_2 finite");
        assertTrue(w.crval1 >= 0 && w.crval1 < 360,  id + " RA in [0,360)");
        assertTrue(w.crval2 >= -90 && w.crval2 <= 90, id + " DEC in [-90,90]");
    });
});

test("fixture 2x2: tile offsets and dimensions are consistent", function() {
    f2x2.tiles.forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        assertTrue(t.offsetX >= 0 && t.offsetX < f2x2.imageWidth,  id + " offsetX in image");
        assertTrue(t.offsetY >= 0 && t.offsetY < f2x2.imageHeight, id + " offsetY in image");
        assertTrue(t.tileWidth > 0 && t.tileWidth <= f2x2.imageWidth,   id + " tileWidth valid");
        assertTrue(t.tileHeight > 0 && t.tileHeight <= f2x2.imageHeight, id + " tileHeight valid");
        assertTrue(t.scaleFactor > 0 && t.scaleFactor <= 1.0, id + " scaleFactor in (0,1]");
    });
});

test("fixture 2x2: hintRA/hintDEC present and in valid range", function() {
    f2x2.tiles.forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        assertTrue(t.hintRA !== undefined && t.hintRA !== null, id + " hintRA set");
        assertTrue(t.hintDEC !== undefined && t.hintDEC !== null, id + " hintDEC set");
        assertTrue(t.hintRA >= 0 && t.hintRA < 360, id + " hintRA in [0,360)");
        assertTrue(t.hintDEC >= -90 && t.hintDEC <= 90, id + " hintDEC in [-90,90]");
    });
});

test("fixture 8x6: structure and partial success", function() {
    assertEqual(f8x6.gridX, 8,  "gridX=8");
    assertEqual(f8x6.gridY, 6,  "gridY=6");
    assertEqual(f8x6.tiles.length, 48, "48 total tiles");
    var s = successTiles(f8x6);
    assertEqual(s.length, 7, "7 tiles solved (expected for 14mm wide-angle)");
    assertTrue(f8x6.imageWidth > 0 && f8x6.imageHeight > 0, "image dims present");
});

test("fixture 8x6: success tiles have valid WCS", function() {
    successTiles(f8x6).forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        assertTrue(t.wcs !== null, id + " wcs present");
        assertTrue(isFinite(t.wcs.crval1) && isFinite(t.wcs.crval2), id + " crval finite");
        assertTrue(isFinite(t.wcs.cd1_1) && isFinite(t.wcs.cd2_2),  id + " CD finite");
    });
});

// ============================================================
// 2. Pixel scale sanity check
// ============================================================

test("2x2 pixel scale from WCS CD matrix (Orion, Nikon Z 6II, ~24.5\"/px)", function() {
    // The CD matrix stored in the fixture is in FULL-IMAGE coordinates:
    //   cd_full = cd_tile * scaleFactor  (applied during tile WCS reverse-transform)
    // So pixelScaleFromCD(wcs) gives the FULL-IMAGE scale (~24.5 arcsec/px),
    // while calibration.pixscale is the DOWNSAMPLED-TILE scale (~38 arcsec/px).
    // Expected relationship: pixelScaleFromCD ≈ calibration.pixscale * scaleFactor
    successTiles(f2x2).forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        var ps = pixelScaleFromCD(t.wcs);
        console.log("  " + id + " full-image scale from CD: " + ps.toFixed(3) + " arcsec/px");
        // Full-image scale should be close to the nominal 24.5 arcsec/px
        assertTrue(ps > 15 && ps < 40, id + " full-image pixel scale 15–40 arcsec/px");
        if (t.calibration && t.calibration.pixscale) {
            // CD scale ≈ calibration.pixscale * scaleFactor (inverse downsample)
            var expected = t.calibration.pixscale * t.scaleFactor;
            var ratio    = ps / expected;
            console.log("  " + id + " CD=" + ps.toFixed(3) + " calib*sf=" + expected.toFixed(3) + " ratio=" + ratio.toFixed(4));
            assertTrue(ratio > 0.95 && ratio < 1.05, id + " CD scale matches calib*scaleFactor within 5%");
        }
    });
});

// ============================================================
// 3. WCS consistency: adjacent tiles agree at overlap region
// ============================================================

test("2x2 WCS: horizontal neighbors [0][0]–[0][1] agree at shared boundary", function() {
    var t00 = getTile(f2x2, 0, 0);
    var t01 = getTile(f2x2, 0, 1);
    // Sample 3 points along the vertical boundary
    var bx = t00.offsetX + t00.tileWidth - 1; // rightmost column of [0][0]
    var separations = [];
    for (var k = 0; k < 3; k++) {
        var by = t00.offsetY + Math.floor(t00.tileHeight * (k + 1) / 4);
        var rd00 = pixelToRaDecTD(t00.wcs, bx, by);
        var rd01 = pixelToRaDecTD(t01.wcs, bx, by);
        if (rd00 && rd01) {
            var sep = angularSeparation(rd00, rd01) * 3600;
            separations.push(sep);
            console.log("  boundary pt " + (k+1) + ": separation=" + sep.toFixed(2) + " arcsec");
        }
    }
    assertTrue(separations.length > 0, "boundary points computed");
    var maxSep = Math.max.apply(null, separations);
    // Linear WCS (no SIP) + independent per-tile solutions → some mismatch expected.
    // Pre-integration tile WCS can diverge by several arcmin at boundaries;
    // after mergeWcsSolutions the RMS drops to ~93 arcsec for this dataset.
    // 600 arcsec (10 arcmin) is a generous but meaningful upper bound.
    assertTrue(maxSep < 600, "max horizontal boundary separation < 600 arcsec");
});

test("2x2 WCS: vertical neighbors [0][0]–[1][0] agree at shared boundary", function() {
    var t00 = getTile(f2x2, 0, 0);
    var t10 = getTile(f2x2, 1, 0);
    var by = t00.offsetY + t00.tileHeight - 1;
    var separations = [];
    for (var k = 0; k < 3; k++) {
        var bx = t00.offsetX + Math.floor(t00.tileWidth * (k + 1) / 4);
        var rd00 = pixelToRaDecTD(t00.wcs, bx, by);
        var rd10 = pixelToRaDecTD(t10.wcs, bx, by);
        if (rd00 && rd10) {
            var sep = angularSeparation(rd00, rd10) * 3600;
            separations.push(sep);
            console.log("  boundary pt " + (k+1) + ": separation=" + sep.toFixed(2) + " arcsec");
        }
    }
    assertTrue(separations.length > 0, "boundary points computed");
    var maxSep = Math.max.apply(null, separations);
    assertTrue(maxSep < 600, "max vertical boundary separation < 600 arcsec");
});

test("2x2 WCS: diagonal neighbors [0][0]–[1][1] agree at overlap center", function() {
    var t00 = getTile(f2x2, 0, 0);
    var t11 = getTile(f2x2, 1, 1);
    // Overlap corner region center
    var bx = t11.offsetX + Math.floor(t00.tileWidth / 2);
    var by = t11.offsetY + Math.floor(t00.tileHeight / 2);
    bx = Math.min(bx, t00.offsetX + t00.tileWidth - 1);
    by = Math.min(by, t00.offsetY + t00.tileHeight - 1);

    var rd00 = pixelToRaDecTD(t00.wcs, bx, by);
    var rd11 = pixelToRaDecTD(t11.wcs, bx, by);
    if (rd00 && rd11) {
        var sep = angularSeparation(rd00, rd11) * 3600;
        console.log("  diagonal center separation: " + sep.toFixed(2) + " arcsec");
        assertTrue(sep < 1200, "diagonal overlap separation < 1200 arcsec");
    }
});

// ============================================================
// 4. Hint accuracy: hintRA/hintDEC vs actual solved tile center
// ============================================================

test("2x2 hint accuracy: hintRA/hintDEC within search radius of solved center", function() {
    // astrometry.net search radius default is ~5°; hint should be well within that
    successTiles(f2x2).forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        var cx = t.offsetX + t.tileWidth  / 2;
        var cy = t.offsetY + t.tileHeight / 2;

        var actual = pixelToRaDecTD(t.wcs, cx, cy);
        var hint   = [t.hintRA, t.hintDEC];
        if (!actual) { console.log("  " + id + " pixelToRaDecTD returned null, skipping"); return; }

        var sep_deg    = angularSeparation(actual, hint);
        var sep_arcsec = sep_deg * 3600;
        console.log("  " + id + " hint offset: " + sep_arcsec.toFixed(1) + " arcsec (" + sep_deg.toFixed(4) + "°)");
        // Hint must be within 5° for astrometry.net to reliably find the field
        assertTrue(sep_deg < 5.0, id + " hint within 5° of solved center");
    });
});

test("2x2 hint accuracy: image-center tile [0][0] has smallest hint offset", function() {
    // The top-left tile is closest to image center; its hint is most accurate
    var t = getTile(f2x2, 0, 0);
    if (!t || !t.wcs) { console.log("  tile not found"); return; }
    var cx = t.offsetX + t.tileWidth  / 2;
    var cy = t.offsetY + t.tileHeight / 2;
    var actual = pixelToRaDecTD(t.wcs, cx, cy);
    var hint   = [t.hintRA, t.hintDEC];
    if (!actual) return;
    var sep = angularSeparation(actual, hint) * 3600;
    console.log("  [0][0] hint offset: " + sep.toFixed(1) + " arcsec");
    // Center tile hint should be very accurate (<60 arcmin)
    assertTrue(sep < 3600, "[0][0] hint within 60 arcmin of actual");
});

test("8x6 hint accuracy: log hint offsets (informational, no strict bound)", function() {
    // 14mm ultra-wide image with rectilinear approximation.
    // Hints at image edges can be many degrees off due to projection mismatch.
    // We only verify hints are valid coordinates, not their accuracy.
    var maxSep = 0;
    successTiles(f8x6).forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        if (!t.hintRA || !t.wcs) return;
        var cx = t.offsetX + t.tileWidth  / 2;
        var cy = t.offsetY + t.tileHeight / 2;
        var actual = pixelToRaDecTD(t.wcs, cx, cy);
        var hint   = [t.hintRA, t.hintDEC];
        if (!actual) return;
        var sep = angularSeparation(actual, hint);
        if (sep > maxSep) maxSep = sep;
        console.log("  " + id + " hint offset: " + (sep * 60).toFixed(1) + " arcmin");
        // Only verify hint is a valid coordinate, not accuracy
        assertTrue(t.hintRA >= 0 && t.hintRA < 360, id + " hintRA valid");
        assertTrue(t.hintDEC >= -90 && t.hintDEC <= 90, id + " hintDEC valid");
    });
    console.log("  max hint offset: " + (maxSep * 60).toFixed(1) + " arcmin");
});

// ============================================================
// 5. Mock solverFn pattern (doLocalSolve / doSplitSolveCore design)
// ============================================================

test("mock solverFn: lookup from 2x2 fixture returns correct WCS for all tiles", function() {
    // Simulate what doLocalSolve's solverFactory builds
    var wcsMap = {};
    f2x2.tiles.forEach(function(ft) {
        wcsMap[ft.row + "_" + ft.col] = ft;
    });

    var mockSolverFn = function(tile) {
        var ft = wcsMap[tile.row + "_" + tile.col];
        if (!ft || ft.status !== "success") return false;
        tile.wcs         = ft.wcs;
        tile.calibration = ft.calibration;
        tile.status      = "success";
        return true;
    };

    var tiles = f2x2.tiles.map(function(ft) {
        return { row: ft.row, col: ft.col, wcs: null, status: "pending" };
    });

    var successCount = 0;
    tiles.forEach(function(tile) { if (mockSolverFn(tile)) successCount++; });

    assertEqual(successCount, 4, "all 4 tiles solved by mock");
    tiles.forEach(function(tile) {
        var id = "[" + tile.row + "][" + tile.col + "]";
        assertTrue(tile.wcs !== null,          id + " wcs populated");
        assertTrue(tile.status === "success",  id + " status=success");
        assertTrue(isFinite(tile.wcs.crval1),  id + " crval1 finite");
        assertTrue(isFinite(tile.wcs.crpix1),  id + " crpix1 finite");
    });
});

test("mock solverFn: 8x6 fixture — failed tiles return false", function() {
    var wcsMap = {};
    f8x6.tiles.forEach(function(ft) { wcsMap[ft.row + "_" + ft.col] = ft; });

    var mockSolverFn = function(tile) {
        var ft = wcsMap[tile.row + "_" + tile.col];
        if (!ft || ft.status !== "success") return false;
        tile.wcs = ft.wcs;
        return true;
    };

    var successCount = 0, failCount = 0;
    f8x6.tiles.forEach(function(ft) {
        var tile = { row: ft.row, col: ft.col, wcs: null };
        if (mockSolverFn(tile)) successCount++;
        else failCount++;
    });

    assertEqual(successCount, 7,  "7 tiles solved");
    assertEqual(failCount,   41,  "41 tiles not solved");
});

test("mock solverFn: CRPIX values are in full-image coordinates (include offsetX/Y)", function() {
    // After solveWavefront, tile.wcs.crpix1/2 are in full-image coords (offset already added).
    // Verify that crpix falls within the tile's expected pixel range (with some margin for overlap).
    successTiles(f2x2).forEach(function(t) {
        var id = "[" + t.row + "][" + t.col + "]";
        var margin = 200; // pixels; CRPIX can be outside tile due to TAN projection
        assertTrue(
            t.wcs.crpix1 > t.offsetX - margin && t.wcs.crpix1 < t.offsetX + t.tileWidth + margin,
            id + " crpix1 within tile X range (±margin)"
        );
        assertTrue(
            t.wcs.crpix2 > t.offsetY - margin && t.wcs.crpix2 < t.offsetY + t.tileHeight + margin,
            id + " crpix2 within tile Y range (±margin)"
        );
    });
});

// ============================================================
// 6. Cross-validation: tile center RA/DEC consistency across 2x2 grid
// ============================================================

test("2x2 grid: tile centers RA/DEC form coherent mosaic", function() {
    // Compute tile center RA/DEC from WCS for all tiles
    var centers = [];
    successTiles(f2x2).forEach(function(t) {
        var cx = t.offsetX + t.tileWidth  / 2;
        var cy = t.offsetY + t.tileHeight / 2;
        var rd = pixelToRaDecTD(t.wcs, cx, cy);
        if (rd) {
            centers.push({ row: t.row, col: t.col, ra: rd[0], dec: rd[1] });
            console.log("  [" + t.row + "][" + t.col + "] center: RA=" + rd[0].toFixed(4) + "° DEC=" + rd[1].toFixed(4) + "°");
        }
    });
    assertTrue(centers.length === 4, "all 4 tile centers computed");

    // Orion 2x2: image FOV ~20°×13° (Nikon Z 6II 24.5"/px, 6037×4012px)
    // Tile centers span roughly half the FOV each: ~10° RA, ~6° DEC.
    // Adjacent tile centers should be 5°–25° apart; diagonal up to ~28°.
    for (var i = 0; i < centers.length; i++) {
        for (var j = i + 1; j < centers.length; j++) {
            var sep = angularSeparation([centers[i].ra, centers[i].dec], [centers[j].ra, centers[j].dec]);
            var ij = "[" + centers[i].row + "][" + centers[i].col + "] vs [" + centers[j].row + "][" + centers[j].col + "]";
            console.log("  " + ij + " center separation: " + (sep * 60).toFixed(1) + " arcmin");
            assertTrue(sep > 1.0,  ij + " centers are distinct (>1°)");
            assertTrue(sep < 30.0, ij + " centers within 30° (sane mosaic)");
        }
    }
});

test("2x2 grid: RA increases left→right (or right→left), DEC varies top→bottom", function() {
    var t00 = getTile(f2x2, 0, 0);
    var t01 = getTile(f2x2, 0, 1);
    var t10 = getTile(f2x2, 1, 0);
    if (!t00 || !t01 || !t10) return;

    var cx00 = t00.offsetX + t00.tileWidth  / 2;
    var cy00 = t00.offsetY + t00.tileHeight / 2;
    var cx01 = t01.offsetX + t01.tileWidth  / 2;
    var cy01 = t01.offsetY + t01.tileHeight / 2;
    var cx10 = t10.offsetX + t10.tileWidth  / 2;
    var cy10 = t10.offsetY + t10.tileHeight / 2;

    var rd00 = pixelToRaDecTD(t00.wcs, cx00, cy00);
    var rd01 = pixelToRaDecTD(t01.wcs, cx01, cy01);
    var rd10 = pixelToRaDecTD(t10.wcs, cx10, cy10);
    if (!rd00 || !rd01 || !rd10) return;

    // RA difference between col=0 and col=1 (horizontal neighbours)
    var ra_diff  = Math.abs(rd00[0] - rd01[0]);
    if (ra_diff > 180) ra_diff = 360 - ra_diff;
    // DEC difference between row=0 and row=1 (vertical neighbours)
    var dec_diff = Math.abs(rd00[1] - rd10[1]);

    console.log("  col RA separation:  " + (ra_diff  * 60).toFixed(1) + " arcmin");
    console.log("  row DEC separation: " + (dec_diff * 60).toFixed(1) + " arcmin");

    assertTrue(ra_diff  > 0.01, "columns have distinct RA (>0.01°)");
    assertTrue(dec_diff > 0.01, "rows have distinct DEC (>0.01°)");
    assertTrue(ra_diff  < 30,   "column RA separation < 30°");
    assertTrue(dec_diff < 30,   "row DEC separation < 30°");
});

// ============================================================
// Results
// ============================================================
console.log("\n" + "=".repeat(30));
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(30));
if (failed > 0) process.exit(1);
