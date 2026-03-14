#!/usr/bin/env node
/**
 * test_solver_equisolid_12x8.js — IT-Solver API (equisolid 12x8, AstrHori 6.5mm fisheye)
 *
 * astrometry.net API を実呼び出しして per-tile ソルブの動作を確認する。
 * wavefront のヒント伝播は使わず、フィクスチャの事前定義ヒントで直接ソルブ。
 *
 * 実行:
 *   node tests/it/api/test_solver_equisolid_12x8.js
 *   ASTROMETRY_API_KEY=xxx node tests/it/api/test_solver_equisolid_12x8.js
 */

"use strict";

var fs   = require("fs");
var path = require("path");
var vm   = require("vm");
var helpers = require("./_helpers");

var MODE          = "equisolid_12x8";
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

var FIXTURE_FILE = path.join(__dirname, "../../fixtures/tile_wcs_equisolid_12x8.json");
var fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

// 精密ヒントフィクスチャ (IT-Solver 用)
var HINTS_FIXTURE_FILE = path.join(__dirname, "../../fixtures/tile_hints_local_equisolid_12x8.json");
if (!fs.existsSync(HINTS_FIXTURE_FILE)) {
    console.error("ERROR: ヒントフィクスチャが見つかりません: " + HINTS_FIXTURE_FILE);
    process.exit(1);
}
var hintsFixture = JSON.parse(fs.readFileSync(HINTS_FIXTURE_FILE, "utf8"));

console.log("=".repeat(70));
console.log("IT-Solver API (equisolid 12x8, AstrHori 6.5mm fisheye)");
console.log("  TILE_DIR=" + TILE_DIR);
console.log("  RATE_LIMIT_MS=" + RATE_LIMIT_MS);
console.log("=".repeat(70));

// ============================================================
// SIS ロード + API ログイン
// ============================================================
var ctx = helpers.loadSisContext();

console.log("\n[STEP 1] astrometry.net ログイン...");
if (!helpers.apiLogin(ctx, API_KEY)) {
    console.error("[FAIL] ログイン失敗");
    process.exit(1);
}
console.log("[STEP 1] ログイン成功");

// ============================================================
// per-tile ソルブ (精密ヒント使用)
// ============================================================
console.log("\n[STEP 2] per-tile ソルブ開始...");

// hintsFixture からタイルヒントマップを構築
var hintMap = {};
hintsFixture.tiles.forEach(function(t) {
    hintMap[t.row + "_" + t.col] = t;
});

// batch_success タイルのみ対象
var targetTiles = hintsFixture.tiles.filter(function(t) { return t.batch_success; });
var successCount = 0;
var results = [];

targetTiles.forEach(function(ht) {
    var key = ht.row + "_" + ht.col;
    var fitsPath = path.join(TILE_DIR, "tile_" + ht.row + "_" + ht.col + ".fits");
    if (!fs.existsSync(fitsPath)) {
        console.log("  [" + ht.row + "][" + ht.col + "] FITS not found, skipping");
        results.push({ row: ht.row, col: ht.col, status: "skipped" });
        return;
    }

    // フィクスチャタイル情報
    var fixTile = null;
    for (var i = 0; i < fixture.tiles.length; i++) {
        if (fixture.tiles[i].row === ht.row && fixture.tiles[i].col === ht.col) {
            fixTile = fixture.tiles[i];
            break;
        }
    }
    if (!fixTile) {
        console.log("  [" + ht.row + "][" + ht.col + "] fixture tile not found, skipping");
        results.push({ row: ht.row, col: ht.col, status: "skipped" });
        return;
    }

    var tile = {
        filePath: fitsPath,
        col: ht.col, row: ht.row,
        offsetX: fixTile.offsetX, offsetY: fixTile.offsetY,
        tileWidth: fixTile.tileWidth, tileHeight: fixTile.tileHeight,
        scaleFactor: fixTile.scaleFactor || 1.0,
        origOffsetX: fixTile.offsetX, origOffsetY: fixTile.offsetY,
        origTileWidth: fixTile.tileWidth, origTileHeight: fixTile.tileHeight,
        wcs: null, calibration: null, status: "pending",
        hintRA: ht.ra_hint, hintDEC: ht.dec_hint
    };

    var tileHints = {
        center_ra:   ht.ra_hint,
        center_dec:  ht.dec_hint,
        scale_lower: ht.scale_lower,
        scale_upper: ht.scale_upper,
        scale_units: "arcsecperpix",
        radius:      10,
        tweak_order: 4
    };

    console.log("  [" + ht.row + "][" + ht.col + "] solving... (RA=" +
        (ht.ra_hint ? ht.ra_hint.toFixed(4) : "N/A") + " DEC=" +
        (ht.dec_hint ? ht.dec_hint.toFixed(4) : "N/A") + ")");

    ctx.TILE_SOLVE = tile;
    ctx.HINTS_SOLVE = tileHints;
    ctx.MEDIAN_SCALE = hintsFixture.median_scale || 0;

    var startMs = Date.now();
    vm.runInContext(
        "solveSingleTile(CLIENT, TILE_SOLVE, HINTS_SOLVE, MEDIAN_SCALE, null);",
        ctx);
    var elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

    if (tile.status === "success" && tile.calibration) {
        successCount++;
        console.log("    -> OK  ra=" + tile.calibration.ra.toFixed(4) +
            " dec=" + tile.calibration.dec.toFixed(4) +
            " scale=" + tile.calibration.pixscale.toFixed(2) + "\"/px (" + elapsedSec + "s)");
        results.push({ row: ht.row, col: ht.col, status: "success" });
    } else {
        console.log("    -> FAIL (" + elapsedSec + "s)");
        results.push({ row: ht.row, col: ht.col, status: "failed" });
    }

    // レートリミット
    if (RATE_LIMIT_MS > 0) {
        var end = Date.now() + RATE_LIMIT_MS;
        while (Date.now() < end) {}
    }
});

// ============================================================
// 結果判定
// ============================================================
var totalTarget = targetTiles.length;

console.log("\n" + "=".repeat(70));
console.log("結果: " + successCount + "/" + totalTarget + " solved");

var pass = true;
// 超広角魚眼は解けるタイルが少なく変動も大きいため、最低1タイル成功で PASS
if (successCount >= 1) {
    console.log("PASS: 最低1タイル成功 (" + successCount + "/" + totalTarget + ")");
} else {
    console.log("FAIL: 全タイル失敗 (0/" + totalTarget + ")");
    pass = false;
}

console.log("=".repeat(70));
process.exit(pass ? 0 : 1);
