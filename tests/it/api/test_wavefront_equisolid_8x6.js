#!/usr/bin/env node
/**
 * test_wavefront_equisolid_8x6.js — IT-Wavefront API (equisolid 8x6, Sigma 15mm fisheye)
 *
 * astrometry.net API を実呼び出しして solveWavefront の
 * ヒント伝播パイプライン全体を検証する (equisolid 魚眼)。
 *
 * 実行:
 *   node tests/it/api/test_wavefront_equisolid_8x6.js
 *   ASTROMETRY_API_KEY=xxx node tests/it/api/test_wavefront_equisolid_8x6.js
 */

"use strict";

var fs   = require("fs");
var path = require("path");
var vm   = require("vm");
var helpers = require("./_helpers");

var MODE          = "equisolid_8x6";
var TILE_DIR      = process.env.TILE_DIR || path.join(__dirname, "../../fits_downsampling/" + MODE);
var RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "2000", 10);

var API_KEY = helpers.loadApiKey();
if (!API_KEY) {
    console.error("ERROR: ASTROMETRY_API_KEY 環境変数または .env ファイルを設定してください");
    process.exit(1);
}
if (!fs.existsSync(TILE_DIR)) {
    console.error("ERROR: TILE_DIR=" + TILE_DIR + " が存在しません");
    process.exit(1);
}

var FIXTURE_FILE = path.join(__dirname, "../../fixtures/tile_wcs_equisolid_8x6.json");
var fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

console.log("=".repeat(70));
console.log("IT-Wavefront API (equisolid 8x6, Sigma 15mm fisheye)");
console.log("  TILE_DIR=" + TILE_DIR);
console.log("  RATE_LIMIT_MS=" + RATE_LIMIT_MS);
console.log("=".repeat(70));

// ============================================================
// SIS ロード + API ログイン
// ============================================================
var ctx = helpers.loadSisContext();

["AstrometryClient", "solveSingleTile", "solveWavefront", "computeTileHints", "pixelToRaDecTD"]
    .forEach(function(fn) {
        if (typeof ctx[fn] !== "function") {
            console.error("ERROR: " + fn + " が context に見つかりません");
            process.exit(1);
        }
    });

console.log("\n[STEP 1] astrometry.net ログイン...");
if (!helpers.apiLogin(ctx, API_KEY)) {
    console.error("[FAIL] ログイン失敗");
    process.exit(1);
}
console.log("[STEP 1] ログイン成功");

// ============================================================
// タイル構築 + ヒント計算
// ============================================================
var gridX = fixture.gridX, gridY = fixture.gridY;
var imgW = fixture.imageWidth, imgH = fixture.imageHeight;
var fHints = fixture.hints;

var hints = {
    center_ra:    fHints.centerRA,
    center_dec:   fHints.centerDEC,
    scale_est:    fHints.scaleEst,
    _nativeScale: fHints.scaleEst,
    _projection:  fHints.projection || "equisolid",
    scale_units:  "arcsecperpix",
    radius:       10,
    tweak_order:  4
};

var tiles = helpers.buildTilesFromFixture(fixture, TILE_DIR, gridX, gridY);

var missingFits = tiles.filter(function(t) { return !fs.existsSync(t.filePath); });
if (missingFits.length > 0) {
    console.error("ERROR: タイル FITS が不足:");
    missingFits.forEach(function(t) { console.error("  " + t.filePath); });
    process.exit(1);
}

console.log("\n[STEP 2] computeTileHints...");
ctx.TILES = tiles; ctx.HINTS = hints; ctx.IMG_W = imgW; ctx.IMG_H = imgH;
vm.runInContext(
    "computeTileHints(TILES, HINTS.center_ra, HINTS.center_dec, HINTS.scale_est, IMG_W, IMG_H, HINTS._projection);",
    ctx);

// ============================================================
// solveWavefront 実行
// ============================================================
console.log("\n[STEP 3] solveWavefront 実行...");
ctx.GRID_X = gridX; ctx.GRID_Y = gridY; ctx.RATE_MS = RATE_LIMIT_MS;

var waveStart = Date.now();
var successCount = vm.runInContext([
    "(function(){",
    "  var realSolverFn = function(tile, tileHints, medianScale, expectedRaDec) {",
    "    return solveSingleTile(CLIENT, tile, tileHints, medianScale, expectedRaDec);",
    "  };",
    "  return solveWavefront(null, TILES, HINTS, IMG_W, IMG_H, GRID_X, GRID_Y,",
    "    function(msg){ console_log(msg); }, realSolverFn,",
    "    function(){return false;}, function(){return false;}, RATE_MS);",
    "})()"
].join("\n"), ctx);
var elapsed = ((Date.now() - waveStart) / 1000).toFixed(1);

// ============================================================
// 結果判定
// ============================================================
var baselineCount = fixture.tiles.filter(function(t) { return t.status === "success"; }).length;

console.log("\n" + "=".repeat(70));
console.log("結果: " + successCount + "/" + tiles.length + " solved (" + elapsed + "s)");
console.log("ベースライン: " + baselineCount + "/" + fixture.tiles.length);

tiles.forEach(function(t) {
    var cal = (t.status === "success" && t.calibration)
        ? "  ra=" + t.calibration.ra.toFixed(4) + " dec=" + t.calibration.dec.toFixed(4)
          + " scale=" + t.calibration.pixscale.toFixed(2) + "\"/px"
        : "";
    console.log("  [" + t.row + "][" + t.col + "] " + t.status + cal);
});

var pass = true;
// 魚眼 + API は変動が大きいため ±4 の許容
if (successCount >= baselineCount - 4) {
    console.log("PASS: 成功タイル数 >= ベースライン-4 (" + successCount + " >= " + (baselineCount - 4) + ")");
} else {
    console.log("FAIL: 成功タイル数がベースライン-4 未満 (" + successCount + " < " + (baselineCount - 4) + ")");
    pass = false;
}
if (successCount < 1) {
    console.log("FAIL: 全タイル失敗");
    pass = false;
}

console.log("=".repeat(70));
process.exit(pass ? 0 : 1);
