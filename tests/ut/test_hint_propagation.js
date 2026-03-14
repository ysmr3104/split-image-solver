#!/usr/bin/env node
/**
 * test_hint_computation.js
 *
 * SplitImageSolver.js の computeTileHints / solveWavefront が
 * 各タイルに正しいヒントを渡しているかを検証する。
 *
 * これがSplitSolveの精度を左右する最重要テスト:
 *   - computeTileHints: 画像中心RA/DECから各タイルの初期RA/DECヒントを計算
 *   - solveWavefront: 解決済みタイルのWCSから refined_center を計算して
 *                     次のタイルに渡す (nearest-solved WCS extrapolation)
 *
 * テスト戦略:
 *   1. SplitImageSolver.js を Node.js に直接ロード (PJSR スタブ使用)
 *   2. フィクスチャのタイル位置メタデータで mock tiles を構築
 *   3. ヒントを記録する recordingMockSolverFn でsolveWavefrontを実行
 *   4. 各タイルが受け取ったヒントを独立計算値と照合
 *
 * 実行方法: node tests/ut/test_hint_propagation.js
 */

"use strict";

var fs   = require("fs");
var path = require("path");
var vm   = require("vm");

// ============================================================
// Test framework
// ============================================================
var passed = 0, failed = 0;

function assertEqual(actual, expected, msg, tolerance) {
    if (tolerance !== undefined) {
        if (actual !== null && actual !== undefined && Math.abs(actual - expected) <= tolerance) {
            passed++;
            console.log("[PASS] " + msg + " (got " + (typeof actual === "number" ? actual.toFixed(6) : actual) + ")");
            return true;
        }
        failed++;
        console.log("[FAIL] " + msg + ": expected " + expected + " ±" + tolerance +
            " got " + actual + " (diff=" + (actual !== null && actual !== undefined ? Math.abs(actual - expected).toFixed(6) : "null") + ")");
        return false;
    }
    if (actual === expected) { passed++; console.log("[PASS] " + msg); return true; }
    failed++; console.log("[FAIL] " + msg + ": expected <" + expected + "> got <" + actual + ">"); return false;
}

function assertTrue(val, msg) {
    if (val) { passed++; console.log("[PASS] " + msg); return true; }
    failed++; console.log("[FAIL] " + msg); return false;
}

function test(name, fn) {
    console.log("\n[TEST] " + name);
    try { fn(); }
    catch (e) { failed++; console.log("[FAIL] Uncaught exception: " + e + "\n" + e.stack); }
}

// ============================================================
// SplitImageSolver.js を Node.js にロード
// ============================================================
function loadSplitImageSolver() {
    var stubs = [
        // console
        "var console = { writeln: function(){}, warningln: function(){}, show: function(){}, criticalln: function(){} };",
        // PJSR runtime
        "var msleep = function(){};",
        "var processEvents = function(){};",
        "var format = function(){ return ''; };",
        // #define 展開
        "var VERSION = '1.0.0'; var VERSION_SUFFIX = ''; var TITLE = 'SIS'; var MAX_PREVIEW_EDGE = 1024;",
        // PJSR UI クラス (prototype = new XXX で参照されるため定義が必要)
        "function Dialog(){}; Dialog.prototype = { execute: function(){} };",
        "function ScrollBox(){}; ScrollBox.prototype = {};",
        "function Control(){}; function Frame(){}; function GroupBox(){};",
        "function TabBox(){}; TabBox.prototype = { addPage: function(){} };",
        "function HorizontalSizer(){}; HorizontalSizer.prototype = { add: function(){}, addItem: function(){}, addStretch: function(){}, addSpacing: function(){}, margin: 0, spacing: 0 };",
        "function VerticalSizer(){}; VerticalSizer.prototype = { add: function(){}, addItem: function(){}, addStretch: function(){}, addSpacing: function(){}, margin: 0, spacing: 0 };",
        "function Label(){}; function Edit(){}; function TextBox(){}; function PushButton(){};",
        "function CheckBox(){}; function ComboBox(){}; ComboBox.prototype = { addItem: function(){}, currentIndex: 0 };",
        "function SpinBox(){}; function NumericControl(){}; function Slider(){};",
        "function TreeBox(){}; TreeBox.prototype = { clear: function(){} }; function TreeBoxNode(){};",
        // PJSR 定数
        "var UndoFlag_NoSwapFile=0; var ImageOp_Mov=0;",
        "var StdIcon_Information=0; var StdIcon_Error=0; var StdIcon_Warning=0;",
        "var StdButton_Ok=0; var StdButton_Cancel=0; var StdButton_Yes=0; var StdButton_No=0;",
        "var PropertyType_String=0; var PropertyAttribute_Storable=0; var PropertyAttribute_Permanent=0; var PropertyAttribute_Protected=0;",
        "var SampleType_UInt16=0; var SampleType_Real32=0; var DataType_Float32=0;",
        "var StdCursor_Arrow=0; var StdCursor_Wait=0; var StdCursor_PointingHand=0;",
        "var TextAlign_VertCenter=0; var TextAlign_Left=0; var TextAlign_Right=0;",
        // PJSR オブジェクト
        "function MessageBox(){ return { execute: function(){return 0;} }; }",
        "var ImageWindow = { open: function(){return [];} };",
        "var File = { systemTempDirectory: '/tmp', exists: function(){return false;}, readTextFile: function(){return '';}, writeTextFile: function(){}, remove: function(){} };",
        "function ExternalProcess(){}; ExternalProcess.prototype = { start: function(){}, waitForFinished: function(){}, environmentVariable: function(){return '';}, setEnvironmentVariable: function(){} };",
    ].join("\n");

    // pixelToRaDecTD が依存する wcs_math.js, wcs_keywords.js も先にロード
    var ctx = vm.createContext({});
    vm.runInContext(stubs, ctx);

    var jsDir = path.join(__dirname, "../../javascript");
    // __dirname = tests/ut

    // 依存ファイルを先にロード
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_math.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_keywords.js"), "utf8"), ctx);

    var code = fs.readFileSync(path.join(jsDir, "SplitImageSolver.js"), "utf8");

    // # プリプロセッサ行を削除 (継続行 \ も対応)
    var lines = code.split("\n");
    var filtered = [];
    var skipNext = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (skipNext) { skipNext = !!line.match(/\\\s*$/); continue; }
        if (line.match(/^\s*#/)) { skipNext = !!line.match(/\\\s*$/); continue; }
        filtered.push(line);
    }
    code = filtered.join("\n").replace(/\nmain\(\);\s*$/, "");
    vm.runInContext(code, ctx);
    return ctx;
}

var sis; // SplitImageSolver.js context
try {
    sis = loadSplitImageSolver();
    console.log("[INFO] SplitImageSolver.js loaded. computeTileHints=" + typeof sis.computeTileHints +
        " solveWavefront=" + typeof sis.solveWavefront);
} catch (e) {
    console.log("[FATAL] Failed to load SplitImageSolver.js: " + e);
    process.exit(1);
}

// ============================================================
// フィクスチャ読み込み
// ============================================================
var FIXTURES_DIR = path.join(__dirname, "../fixtures");
function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}
var f2x2 = loadFixture("tile_wcs_api_2x2.json");
var f8x6 = loadFixture("tile_wcs_api_8x6.json");

// ============================================================
// ヘルパー
// ============================================================

// フィクスチャからsolveWavefront用の mock tiles を構築
function buildMockTiles(fixture) {
    return fixture.tiles.map(function(t) {
        return {
            row:        t.row,
            col:        t.col,
            offsetX:    t.offsetX,
            offsetY:    t.offsetY,
            tileWidth:  t.tileWidth,
            tileHeight: t.tileHeight,
            scaleFactor: t.scaleFactor || 1.0,
            filePath:   "/mock/" + t.row + "_" + t.col + ".fits",
            // hintRA/hintDEC は computeTileHints 呼び出し後にセットされる
            status: "pending",  // wavefront が nb.status === "pending" を条件にキューイングするため必須
            wcs: null,
            calibration: null
        };
    });
}

// フィクスチャから hints オブジェクトを構築 (doSplitSolveCore が solveWavefront に渡す形式)
function buildHints(fixture) {
    var h = fixture.hints;
    return {
        center_ra:    h.centerRA,
        center_dec:   h.centerDEC,
        scale_est:    h.scaleEst,
        _nativeScale: h.scaleEst,
        _projection:  h.projection || "rectilinear"
    };
}

// フィクスチャタイルを row_col キーで引けるマップ
function buildFixtureMap(fixture) {
    var map = {};
    fixture.tiles.forEach(function(t) { map[t.row + "_" + t.col] = t; });
    return map;
}

// 最近傍タイルを探す (ピクセル距離)
function findNearest(tile, candidates) {
    var tileCX = tile.offsetX + tile.tileWidth / 2.0;
    var tileCY = tile.offsetY + tile.tileHeight / 2.0;
    var nearest = null, minDist2 = Infinity;
    candidates.forEach(function(c) {
        var cx = c.offsetX + c.tileWidth / 2.0;
        var cy = c.offsetY + c.tileHeight / 2.0;
        var d2 = (tileCX-cx)*(tileCX-cx) + (tileCY-cy)*(tileCY-cy);
        if (d2 < minDist2) { minDist2 = d2; nearest = c; }
    });
    return nearest;
}

// ヒントを記録しながらフィクスチャWCSを返すモック
function makeRecordingMock(fixture) {
    var fixtureMap = buildFixtureMap(fixture);
    var solvedTiles = [];  // 成功タイルの配列 (呼び出し順)
    var attempts   = [];   // 全呼び出しの記録

    var mockFn = function(tile, tileHints, medianScale, expectedRaDec) {
        // 呼び出し時点での成功タイルをスナップショット
        var solvedBefore = solvedTiles.slice(0);

        attempts.push({
            tileKey:     tile.row + "_" + tile.col,
            tile:        tile,
            hints:       {
                center_ra:   tileHints.center_ra,
                center_dec:  tileHints.center_dec,
                scale_lower: tileHints.scale_lower,
                scale_upper: tileHints.scale_upper
            },
            solvedBefore: solvedBefore
        });

        var r = fixtureMap[tile.row + "_" + tile.col];
        if (!r || !r.wcs) return false;
        tile.wcs        = r.wcs;
        tile.calibration = r.calibration;
        solvedTiles.push(tile);
        return true;
    };

    mockFn.attempts    = attempts;
    mockFn.solvedTiles = solvedTiles;
    return mockFn;
}

// ============================================================
// TEST GROUP 1: computeTileHints — 初期RA/DECヒントの検証
// ============================================================
console.log("\n" + "=".repeat(60));
console.log("GROUP 1: computeTileHints — 初期RA/DECヒント");
console.log("=".repeat(60));

test("2x2: computeTileHints output matches fixture stored hintRA/hintDEC", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var fixMap = buildFixtureMap(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    tiles.forEach(function(tile) {
        var fTile = fixMap[tile.row + "_" + tile.col];
        var tag = "[" + tile.row + "][" + tile.col + "]";
        // 0.01° = 36 arcsec の許容 (同じコードなので実際は <1e-9 のはず)
        assertEqual(tile.hintRA,  fTile.hintRA,  tag + " hintRA",  0.01);
        assertEqual(tile.hintDEC, fTile.hintDEC, tag + " hintDEC", 0.01);
    });
});

test("8x6: computeTileHints output matches fixture stored hintRA/hintDEC (center tiles)", function() {
    var tiles = buildMockTiles(f8x6);
    var h = buildHints(f8x6);
    var fixMap = buildFixtureMap(f8x6);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f8x6.imageWidth, f8x6.imageHeight, h._projection);

    // 成功タイルのみ検証 (hint は全タイルに設定されるが成功タイルで確認)
    var successTiles = f8x6.tiles.filter(function(t){ return t.status === "success"; });
    successTiles.forEach(function(fTile) {
        var tile = tiles.filter(function(t){ return t.row===fTile.row && t.col===fTile.col; })[0];
        var tag = "[" + tile.row + "][" + tile.col + "]";
        assertEqual(tile.hintRA,  fTile.hintRA,  tag + " hintRA",  0.01);
        assertEqual(tile.hintDEC, fTile.hintDEC, tag + " hintDEC", 0.01);
    });
});

test("2x2: computeTileHints — corner tiles RA direction (West is positive offsetX)", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    // [0][0] (upper-left) should be East (higher RA in typical northern sky)
    // [0][1] (upper-right) should be West (lower RA)
    var t00 = tiles.filter(function(t){ return t.row===0 && t.col===0; })[0];
    var t01 = tiles.filter(function(t){ return t.row===0 && t.col===1; })[0];
    assertTrue(t00.hintRA > t01.hintRA,
        "upper-left tile RA > upper-right tile RA (East-West direction correct)");
});

test("2x2: computeTileHints — vertical tiles DEC direction", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    var t00 = tiles.filter(function(t){ return t.row===0 && t.col===0; })[0];
    var t10 = tiles.filter(function(t){ return t.row===1 && t.col===0; })[0];
    // upper tile (row=0, offsetY=0) should have higher DEC than lower tile (row=1)
    assertTrue(t00.hintDEC > t10.hintDEC,
        "upper tile DEC > lower tile DEC (North-South direction correct)");
});

// ============================================================
// TEST GROUP 2: solveWavefront — refined_center の検証
// ============================================================
console.log("\n" + "=".repeat(60));
console.log("GROUP 2: solveWavefront — refined_center ヒントの検証");
console.log("=".repeat(60));

test("2x2: seed tile receives computeTileHints output as center hint", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var mock = makeRecordingMock(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    assertTrue(mock.attempts.length > 0, "at least one tile was attempted");
    var seedAttempt = mock.attempts[0]; // 最初の呼び出し = seed tile
    var seedTile = seedAttempt.tile;
    var seedFixtile = buildFixtureMap(f2x2)[seedAttempt.tileKey];

    console.log("  seed tile: [" + seedTile.row + "][" + seedTile.col + "]");
    console.log("  recorded center_ra=" + seedAttempt.hints.center_ra +
        " hintRA=" + seedFixtile.hintRA);
    console.log("  recorded center_dec=" + seedAttempt.hints.center_dec +
        " hintDEC=" + seedFixtile.hintDEC);

    assertTrue(seedAttempt.solvedBefore.length === 0, "seed tile has no solved tiles before it");
    // seed tile: center_ra should = hintRA (from computeTileHints)
    assertEqual(seedAttempt.hints.center_ra,  seedFixtile.hintRA,  "seed center_ra = hintRA",  0.001);
    assertEqual(seedAttempt.hints.center_dec, seedFixtile.hintDEC, "seed center_dec = hintDEC", 0.001);
});

test("2x2: non-seed tiles receive refined_center from nearest solved tile WCS", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var mock = makeRecordingMock(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    // seed tile 以外の全試行を検証
    mock.attempts.slice(1).forEach(function(rec) {
        if (rec.solvedBefore.length === 0) return; // shouldn't happen for non-seed

        var tile = rec.tile;
        var tileCX = tile.offsetX + tile.tileWidth / 2.0;
        var tileCY = tile.offsetY + tile.tileHeight / 2.0;
        var nearest = findNearest(tile, rec.solvedBefore);
        var expected = sis.pixelToRaDecTD(nearest.wcs, tileCX, tileCY);
        var tag = "[" + tile.row + "][" + tile.col + "] (ref=[" + nearest.row + "][" + nearest.col + "])";

        console.log("  " + tag);
        console.log("    expected center_ra=" + expected[0].toFixed(4) +
            " recorded=" + (rec.hints.center_ra !== undefined ? rec.hints.center_ra.toFixed(4) : "NONE"));
        console.log("    expected center_dec=" + expected[1].toFixed(4) +
            " recorded=" + (rec.hints.center_dec !== undefined ? rec.hints.center_dec.toFixed(4) : "NONE"));

        // pixelToRaDecTD の出力と記録値は完全一致するはず (同じ計算)
        // 浮動小数点の差 < 1e-9 を許容
        assertEqual(rec.hints.center_ra,  expected[0], tag + " center_ra",  1e-6);
        assertEqual(rec.hints.center_dec, expected[1], tag + " center_dec", 1e-6);
    });
});

test("2x2: WCS-extrapolated tiles get widened scale range (midScale * 0.5 ~ 1.5)", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var mock = makeRecordingMock(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    // Wave2以降のタイル: scale_lower/upper は midScale * 0.5 / 1.5
    mock.attempts.slice(1).forEach(function(rec) {
        if (rec.solvedBefore.length === 0) return;
        if (!rec.hints.scale_lower || !rec.hints.scale_upper) return;

        var mid = (rec.hints.scale_lower + rec.hints.scale_upper) / 2.0;
        var tag = "[" + rec.tile.row + "][" + rec.tile.col + "]";

        console.log("  " + tag + " scale=[" + rec.hints.scale_lower.toFixed(1) + "-" + rec.hints.scale_upper.toFixed(1) + "]\"/px mid=" + mid.toFixed(1));

        // WCS-extrapolated: lower = mid*0.5, upper = mid*1.5 → ratio = 3.0
        var ratio = rec.hints.scale_upper / rec.hints.scale_lower;
        assertTrue(Math.abs(ratio - 3.0) < 0.01,
            tag + " scale range ratio = 3.0 (midScale*0.5 ~ midScale*1.5)");
    });
});

test("8x6: seed tile center hint matches computeTileHints output", function() {
    var tiles = buildMockTiles(f8x6);
    var h = buildHints(f8x6);
    var mock = makeRecordingMock(f8x6);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f8x6.imageWidth, f8x6.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f8x6.imageWidth, f8x6.imageHeight, f8x6.gridX, f8x6.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    var seed = mock.attempts[0];
    var seedFixTile = buildFixtureMap(f8x6)[seed.tileKey];
    console.log("  seed tile: [" + seed.tile.row + "][" + seed.tile.col + "]");
    assertTrue(seed.solvedBefore.length === 0, "seed has no predecessors");
    assertEqual(seed.hints.center_ra,  seedFixTile.hintRA,  "seed center_ra = hintRA",  0.001);
    assertEqual(seed.hints.center_dec, seedFixTile.hintDEC, "seed center_dec = hintDEC", 0.001);
});

test("8x6: successful tiles receive correct refined_center from nearest solved WCS", function() {
    var tiles = buildMockTiles(f8x6);
    var h = buildHints(f8x6);
    var mock = makeRecordingMock(f8x6);
    var fixMap = buildFixtureMap(f8x6);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f8x6.imageWidth, f8x6.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f8x6.imageWidth, f8x6.imageHeight, f8x6.gridX, f8x6.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    // 成功タイル (seed以外) のヒントを検証
    var successAttempts = mock.attempts.filter(function(rec) {
        var r = fixMap[rec.tileKey];
        return r && r.status === "success" && rec.solvedBefore.length > 0;
    });

    console.log("  Validating " + successAttempts.length + " non-seed successful tile hints");
    successAttempts.forEach(function(rec) {
        var tile = rec.tile;
        var tileCX = tile.offsetX + tile.tileWidth / 2.0;
        var tileCY = tile.offsetY + tile.tileHeight / 2.0;
        var nearest = findNearest(tile, rec.solvedBefore);
        var expected = sis.pixelToRaDecTD(nearest.wcs, tileCX, tileCY);
        var tag = "[" + tile.row + "][" + tile.col + "] ref=[" + nearest.row + "][" + nearest.col + "]";

        console.log("  " + tag + " expected_ra=" + expected[0].toFixed(4) +
            " recorded=" + (rec.hints.center_ra !== undefined ? rec.hints.center_ra.toFixed(4) : "NONE") +
            " diff=" + (rec.hints.center_ra !== undefined ? Math.abs(rec.hints.center_ra - expected[0]).toFixed(6) : "n/a"));

        assertEqual(rec.hints.center_ra,  expected[0], tag + " center_ra",  1e-6);
        assertEqual(rec.hints.center_dec, expected[1], tag + " center_dec", 1e-6);
    });
});

// ============================================================
// TEST GROUP 3: scale range の正しさ
// ============================================================
console.log("\n" + "=".repeat(60));
console.log("GROUP 3: scale range — スケールヒントの検証");
console.log("=".repeat(60));

test("2x2: seed tile scale range is centered around projection-corrected scale_est", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var mock = makeRecordingMock(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    var seed = mock.attempts[0];
    var mid = (seed.hints.scale_lower + seed.hints.scale_upper) / 2.0;
    var scaleFactor = seed.tile.scaleFactor || 1.0;
    // seed scale: scale_est / scaleFactor (downsampled) * projection factor
    // 中心タイルなので projection factor ≈ 1.0
    var expectedMid = h.scale_est / scaleFactor;
    console.log("  seed scale: lower=" + seed.hints.scale_lower.toFixed(2) +
        " upper=" + seed.hints.scale_upper.toFixed(2) + " mid=" + mid.toFixed(2) +
        " scale_est/factor=" + expectedMid.toFixed(2));
    // mid は scale_est/scaleFactor に近いはず (±40% = 中心タイルの margin)
    var ratio = mid / expectedMid;
    assertTrue(ratio > 0.7 && ratio < 1.5,
        "seed tile scale midpoint within 50% of expected (scale_est / scaleFactor)");
});

test("2x2: all tiles have valid scale_lower < scale_upper", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var mock = makeRecordingMock(f2x2);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    mock.attempts.forEach(function(rec) {
        var tag = "[" + rec.tile.row + "][" + rec.tile.col + "]";
        assertTrue(rec.hints.scale_lower > 0, tag + " scale_lower > 0");
        assertTrue(rec.hints.scale_upper > rec.hints.scale_lower,
            tag + " scale_lower < scale_upper");
    });
});

test("8x6: all attempted tiles have valid scale_lower < scale_upper", function() {
    var tiles = buildMockTiles(f8x6);
    var h = buildHints(f8x6);
    var mock = makeRecordingMock(f8x6);

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f8x6.imageWidth, f8x6.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f8x6.imageWidth, f8x6.imageHeight, f8x6.gridX, f8x6.gridY,
        function(){}, mock,
        function(){return false;}, function(){return false;}, 0);

    mock.attempts.forEach(function(rec) {
        var tag = "[" + rec.tile.row + "][" + rec.tile.col + "]";
        assertTrue(rec.hints.scale_lower > 0, tag + " scale_lower > 0");
        assertTrue(rec.hints.scale_upper > rec.hints.scale_lower,
            tag + " scale_lower < scale_upper");
    });
});

// ============================================================
// TEST GROUP 4: solveWavefront — 失敗タイル発生時の enqueue パターン (項目3)
// ============================================================
console.log("\n" + "=".repeat(60));
console.log("GROUP 4: solveWavefront — 失敗タイル発生時の enqueue パターン");
console.log("=".repeat(60));

test("2x2: 失敗タイルの隣接タイルもキューイングされる", function() {
    // seed タイルを失敗させても、隣接タイルは全てキューに入る
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var fixtureMap = buildFixtureMap(f2x2);

    var attemptedKeys = [];
    var failSeedMock = function(tile, tileHints, medianScale, expectedRaDec) {
        var key = tile.row + "_" + tile.col;
        attemptedKeys.push(key);

        // seed タイル (最初の呼び出し) を失敗させる
        if (attemptedKeys.length === 1) {
            tile.status = "failed";
            return false;
        }

        // 以降のタイルは成功させる (フィクスチャ WCS を返す)
        var r = fixtureMap[key];
        if (r && r.wcs) {
            tile.wcs = r.wcs;
            tile.calibration = r.calibration;
            return true;
        }
        tile.status = "failed";
        return false;
    };

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, failSeedMock,
        function(){return false;}, function(){return false;}, 0);

    // 全 4 タイルが試行されるべき (seed 失敗後も隣接がキューイングされる)
    assertTrue(attemptedKeys.length === 4,
        "all 4 tiles attempted even when seed fails: " + attemptedKeys.length);
    console.log("  attempted order: " + attemptedKeys.join(" → "));
});

test("2x2: 全タイル失敗でも wavefront は停止しない", function() {
    var tiles = buildMockTiles(f2x2);
    var h = buildHints(f2x2);
    var attemptCount = 0;

    var allFailMock = function(tile, tileHints, medianScale, expectedRaDec) {
        attemptCount++;
        tile.status = "failed";
        return false;
    };

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f2x2.imageWidth, f2x2.imageHeight, h._projection);

    var result = sis.solveWavefront(null, tiles, h,
        f2x2.imageWidth, f2x2.imageHeight, f2x2.gridX, f2x2.gridY,
        function(){}, allFailMock,
        function(){return false;}, function(){return false;}, 0);

    assertEqual(result, 0, "0 tiles solved when all fail");
    assertTrue(attemptCount === 4, "all 4 tiles attempted: " + attemptCount);
});

test("8x6: 部分的失敗でも wavefront は隣接タイルに伝播", function() {
    var tiles = buildMockTiles(f8x6);
    var h = buildHints(f8x6);
    var fixtureMap = buildFixtureMap(f8x6);
    var attemptCount = 0;
    var successCount = 0;

    // 偶数番目の試行を失敗させる
    var partialFailMock = function(tile, tileHints, medianScale, expectedRaDec) {
        attemptCount++;
        if (attemptCount % 2 === 0) {
            tile.status = "failed";
            return false;
        }
        var key = tile.row + "_" + tile.col;
        var r = fixtureMap[key];
        if (r && r.wcs) {
            tile.wcs = r.wcs;
            tile.calibration = r.calibration;
            successCount++;
            return true;
        }
        tile.status = "failed";
        return false;
    };

    sis.computeTileHints(tiles, h.center_ra, h.center_dec, h.scale_est,
        f8x6.imageWidth, f8x6.imageHeight, h._projection);

    sis.solveWavefront(null, tiles, h,
        f8x6.imageWidth, f8x6.imageHeight, f8x6.gridX, f8x6.gridY,
        function(){}, partialFailMock,
        function(){return false;}, function(){return false;}, 0);

    // 全タイルが試行されるべき
    assertEqual(attemptCount, tiles.length, "all tiles attempted despite partial failures");
    assertTrue(successCount > 0, "some tiles succeeded: " + successCount);
    console.log("  attempted=" + attemptCount + " succeeded=" + successCount);
});

// ============================================================
// 結果
// ============================================================
console.log("\n" + "=".repeat(30));
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(30));
process.exit(failed > 0 ? 1 : 0);
