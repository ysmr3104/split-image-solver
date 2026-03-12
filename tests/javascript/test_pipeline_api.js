#!/usr/bin/env node
/**
 * test_pipeline_api.js  (Case B: solveWavefront を直接呼び出す)
 *
 * astrometry.net API を使い、solveWavefront() を実際に呼び出して
 * hint 伝播チェーン（buildTileHints → solveSingleTile → 次タイルの refined ヒント）
 * を end-to-end で検証する。
 *
 * 旧 test_api_integration.js との違い:
 *   旧: solveSingleTile を手動ループで呼び出し (buildTileHints をスキップ)
 *   新: solveWavefront を呼び出し (buildTileHints 込みのフル wavefront パイプライン)
 *
 * 前提:
 *   - TILE_DIR に tile_{row}_{col}.fits が存在すること
 *     (PixInsight で debugTileDir を設定して一度実行すること)
 *   - 環境変数 ASTROMETRY_API_KEY が設定されていること
 *   - フィクスチャ tests/javascript/fixtures/tile_wcs_api_{MODE}.json が存在すること
 *
 * 実行:
 *   ASTROMETRY_API_KEY=xxxx node tests/javascript/test_pipeline_api.js [2x2|8x6]
 *   ASTROMETRY_API_KEY=xxxx TILE_DIR=/path/to/tiles node tests/javascript/test_pipeline_api.js 2x2
 */

"use strict";

var fs            = require("fs");
var path          = require("path");
var vm            = require("vm");
var os            = require("os");
var child_process = require("child_process");

// ============================================================
// 設定
// ============================================================
var API_KEY       = process.env.ASTROMETRY_API_KEY || "";
var MODE          = process.argv[2] || "2x2";
var TILE_DIR      = process.env.TILE_DIR || path.join(__dirname, "../fits_downsampling/" + MODE);
var TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS    || "120000", 10);
var RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "2000",   10);

if (!API_KEY) {
    console.error("ERROR: ASTROMETRY_API_KEY 環境変数を設定してください");
    process.exit(1);
}
if (!fs.existsSync(TILE_DIR)) {
    console.error("ERROR: TILE_DIR=" + TILE_DIR + " が存在しません");
    process.exit(1);
}

var FIXTURE_FILE = path.join(__dirname, "fixtures/tile_wcs_api_" + MODE + ".json");
if (!fs.existsSync(FIXTURE_FILE)) {
    console.error("ERROR: フィクスチャが見つかりません: " + FIXTURE_FILE);
    process.exit(1);
}

var fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

console.log("=".repeat(70));
console.log("API パイプラインテスト (Case B: solveWavefront 直接呼び出し)");
console.log("  MODE=" + MODE + "  fixture=" + FIXTURE_FILE);
console.log("  TILE_DIR=" + TILE_DIR);
console.log("  TIMEOUT_MS=" + TIMEOUT_MS + "  RATE_LIMIT_MS=" + RATE_LIMIT_MS);
console.log("=".repeat(70));

// ============================================================
// PJSR → Node.js スタブ
// ============================================================
function loadSisContext() {
    var ctx = vm.createContext({
        // Node.js globals を context に渡す
        process:       process,
        console_log:   function(s) { process.stdout.write("[SIS] " + String(s) + "\n"); }
    });

    // PJSR スタブ
    vm.runInContext([
        "var console = { writeln: console_log, warningln: console_log, criticalln: console_log,",
        "    show: function(){}, log: console_log, abortRequested: false };",
        "var msleep = function(ms){ var end = Date.now()+ms; while(Date.now()<end){} };",
        "var processEvents = function(){};",
        "var VERSION='1.0.0'; var VERSION_SUFFIX=''; var TITLE='SIS'; var MAX_PREVIEW_EDGE=1024;",
        "function Dialog(){}; Dialog.prototype={execute:function(){}};",
        "function ScrollBox(){};",
        "function HorizontalSizer(){}; HorizontalSizer.prototype={add:function(){},addItem:function(){},addStretch:function(){},addSpacing:function(){},margin:0,spacing:0};",
        "function VerticalSizer(){}; VerticalSizer.prototype={add:function(){},addItem:function(){},addStretch:function(){},addSpacing:function(){},margin:0,spacing:0};",
        "function Label(){}; function Edit(){}; function PushButton(){}; function CheckBox(){};",
        "function ComboBox(){}; ComboBox.prototype={addItem:function(){},currentIndex:0};",
        "function SpinBox(){}; function NumericControl(){}; function TreeBox(){}; TreeBox.prototype={clear:function(){}};",
        "function TreeBoxNode(){}; function GroupBox(){}; function Slider(){}; function Control(){}; function Frame(){}; function TabBox(){}; TabBox.prototype={addPage:function(){}};",
        "function TextBox(){};",
        "var format=function(){return '';};",
        "var UndoFlag_NoSwapFile=0; var ImageOp_Mov=0;",
        "var StdIcon_Information=0; var StdIcon_Error=0; var StdButton_Ok=0; var StdButton_Cancel=0;",
        "var PropertyType_String=0; var PropertyAttribute_Storable=0; var PropertyAttribute_Permanent=0; var PropertyAttribute_Protected=0;",
        "var SampleType_UInt16=0; var SampleType_Real32=0; var DataType_Float32=0; var StdCursor_Arrow=0;",
        "function MessageBox(){return{execute:function(){return 0;}};}",
        "var ImageWindow={open:function(){return[];}};",
    ].join("\n"), ctx);

    var jsDir = path.join(__dirname, "../../javascript");

    // 依存 JS ファイル
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_math.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_keywords.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(jsDir, "astrometry_api.js"), "utf8"), ctx);

    // SplitImageSolver.js (#include 行と末尾 main() を除去)
    var code  = fs.readFileSync(path.join(jsDir, "SplitImageSolver.js"), "utf8");
    var lines = code.split("\n");
    var filtered = [], skip = false;
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (skip) { skip = !!l.match(/\\\s*$/); continue; }
        if (l.match(/^\s*#/)) { skip = !!l.match(/\\\s*$/); continue; }
        filtered.push(l);
    }
    vm.runInContext(filtered.join("\n").replace(/\nmain\(\);\s*$/, ""), ctx);

    // Node.js バインディング (ExternalProcess, File)
    ctx.ExternalProcess = function() { this.exitCode = 0; };
    ctx.ExternalProcess.prototype.start = function(cmd, args) {
        try {
            var r = child_process.spawnSync(cmd, args || [], {
                timeout: TIMEOUT_MS + 30000,
                maxBuffer: 10 * 1024 * 1024
            });
            this.exitCode = (r.status !== null) ? r.status : 1;
        } catch (e) {
            this.exitCode = 1;
        }
    };
    ctx.ExternalProcess.prototype.waitForFinished = function() { return true; };
    ctx.ExternalProcess.prototype.kill = function() {};

    ctx.File = {
        systemTempDirectory: os.tmpdir(),
        exists:          function(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } },
        readTextFile:    function(p) { return fs.readFileSync(p, "utf8"); },
        writeTextFile:   function(p, c) { fs.writeFileSync(p, c, "utf8"); },
        remove:          function(p) { try { fs.unlinkSync(p); } catch (e) {} },
        createDirectory: function(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
    };

    return ctx;
}

// ============================================================
// タイル配列の構築 (fixture → tiles, center-first ソート)
// splitImageToTiles と同じソート順にすることで
// solveWavefront が tiles[0] を正しいウェーブ0として扱う
// ============================================================
function buildTilesFromFixture(fixture, tileDir, gridX, gridY) {
    var centerCol = (gridX - 1) / 2.0;
    var centerRow = (gridY - 1) / 2.0;
    var upperRowLimit = Math.ceil(gridY / 2.0);

    var tiles = fixture.tiles.map(function(t) {
        return {
            filePath:      path.join(tileDir, "tile_" + t.row + "_" + t.col + ".fits"),
            col: t.col,   row: t.row,
            offsetX:       t.offsetX,    offsetY:       t.offsetY,
            tileWidth:     t.tileWidth,  tileHeight:    t.tileHeight,
            scaleFactor:   t.scaleFactor || 1.0,
            origOffsetX:   t.offsetX,    origOffsetY:   t.offsetY,
            origTileWidth: t.tileWidth,  origTileHeight: t.tileHeight,
            wcs: null, calibration: null,
            status: "pending",
            hintRA: undefined, hintDEC: undefined
        };
    });

    // splitImageToTiles と同一ソート
    tiles.sort(function(a, b) {
        var aUpper = (a.row < upperRowLimit) ? 0 : 1;
        var bUpper = (b.row < upperRowLimit) ? 0 : 1;
        if (aUpper !== bUpper) return aUpper - bUpper;
        var da = (a.col - centerCol) * (a.col - centerCol) + (a.row - centerRow) * (a.row - centerRow);
        var db = (b.col - centerCol) * (b.col - centerCol) + (b.row - centerRow) * (b.row - centerRow);
        if (da !== db) return da - db;
        if (a.row !== b.row) return a.row - b.row;
        return a.col - b.col;
    });

    return tiles;
}

// ============================================================
// メイン実行
// ============================================================
var ctx = loadSisContext();

// 必要な関数の存在チェック
["AstrometryClient", "solveSingleTile", "solveWavefront", "computeTileHints", "pixelToRaDecTD"]
    .forEach(function(fn) {
        if (typeof ctx[fn] !== "function") {
            console.error("ERROR: " + fn + " が context に見つかりません");
            process.exit(1);
        }
        console.log("  ✓ " + fn);
    });

var gridX   = fixture.gridX;
var gridY   = fixture.gridY;
var imgW    = fixture.imageWidth;
var imgH    = fixture.imageHeight;
var fHints  = fixture.hints;

// solveWavefront / buildTileHints が参照するヒントオブジェクト
// (buildTileHints はこのオブジェクトを for..in でコピーし、
//  scale_units / radius / tweak_order もコピーされる)
var hints = {
    center_ra:    fHints.centerRA,
    center_dec:   fHints.centerDEC,
    scale_est:    fHints.scaleEst,
    _nativeScale: fHints.scaleEst,
    _projection:  fHints.projection || "rectilinear",
    // astrometry.net API が必要とするフィールド (buildTileHints がコピーする)
    scale_units:  "arcsecperpix",
    radius:       10,
    tweak_order:  4
};

// タイル配列を center-first ソートで構築
var tiles = buildTilesFromFixture(fixture, TILE_DIR, gridX, gridY);

// FITS 存在チェック
var missingFits = tiles.filter(function(t) { return !fs.existsSync(t.filePath); });
if (missingFits.length > 0) {
    console.error("ERROR: 以下のタイルFITSが見つかりません:");
    missingFits.forEach(function(t) { console.error("  " + t.filePath); });
    process.exit(1);
}
console.log("\n利用可能タイルFITS: " + tiles.length + "/" + fixture.tiles.length);
console.log("Wavefront 開始タイル (tiles[0]): [" + tiles[0].col + "," + tiles[0].row + "]");

// ============================================================
// STEP 1: computeTileHints — 初期 RA/DEC ヒント設定
// ============================================================
console.log("\n[STEP 1] computeTileHints: 初期 RA/DEC ヒント計算...");
ctx.TILES_STEP1 = tiles;
ctx.HINTS_STEP1 = hints;
ctx.IMG_W = imgW;
ctx.IMG_H = imgH;
vm.runInContext(
    "(function(){" +
    "  computeTileHints(TILES_STEP1, HINTS_STEP1.center_ra, HINTS_STEP1.center_dec," +
    "    HINTS_STEP1.scale_est, IMG_W, IMG_H, HINTS_STEP1._projection);" +
    "  TILES_STEP1.forEach(function(t){" +
    "    var ra  = t.hintRA  !== undefined ? t.hintRA.toFixed(4)  : 'N/A';" +
    "    var dec = t.hintDEC !== undefined ? t.hintDEC.toFixed(4) : 'N/A';" +
    "    console_log('  [' + t.row + '][' + t.col + '] hintRA=' + ra + ' hintDEC=' + dec);" +
    "  });" +
    "})()",
    ctx);
console.log("[STEP 1] 完了");

// ============================================================
// STEP 2: API ログイン
// ============================================================
console.log("\n[STEP 2] astrometry.net ログイン...");
ctx.API_KEY_STEP2 = API_KEY;
ctx.TIMEOUT_STEP2 = TIMEOUT_MS;
var loginOk = vm.runInContext([
    "(function(){",
    "  var c = new AstrometryClient(API_KEY_STEP2);",
    "  c.timeout = TIMEOUT_STEP2;",
    "  c.abortCheck = function(){ return false; };",
    "  c.skipCheck  = function(){ return false; };",
    "  if (!c.login()) return false;",
    "  console_log('[STEP 2] session=' + c.session);",
    "  CLIENT = c;",   // ctx.CLIENT にセット
    "  return true;",
    "})()"
].join("\n"), ctx);

if (!loginOk) {
    console.error("[FAIL] ログイン失敗");
    process.exit(1);
}
console.log("[STEP 2] ログイン成功");

// ============================================================
// STEP 3: solveWavefront 呼び出し (Case B)
// ============================================================
console.log("\n[STEP 3] solveWavefront 実行 (Case B: hint 伝播チェーン検証)...");
console.log("  → solveSingleTile を realSolverFn として渡す");
console.log("  → buildTileHints が各タイルの effective scale / refined RA/DEC を計算");
console.log("  → 解けたタイルの WCS から次のタイルの hint を改善");

ctx.TILES_STEP3    = tiles;
ctx.HINTS_STEP3    = hints;
ctx.GRID_X         = gridX;
ctx.GRID_Y         = gridY;
ctx.RATE_LIMIT_MS3 = RATE_LIMIT_MS;

var waveStart = Date.now();

var successCount = vm.runInContext([
    "(function(){",
    "  var realSolverFn = function(tile, tileHints, medianScale, expectedRaDec) {",
    "    return solveSingleTile(CLIENT, tile, tileHints, medianScale, expectedRaDec);",
    "  };",
    "  return solveWavefront(",
    "    null,",                              // client (abortCheck は abortCheckFn で代替)
    "    TILES_STEP3,",
    "    HINTS_STEP3,",
    "    IMG_W, IMG_H,",
    "    GRID_X, GRID_Y,",
    "    function(msg){ console_log(msg); },", // progressCallback
    "    realSolverFn,",
    "    function(){ return false; },",        // abortCheckFn
    "    function(){ return false; },",        // skipCheckFn
    "    RATE_LIMIT_MS3",
    "  );",
    "})()"
].join("\n"), ctx);

var elapsed = ((Date.now() - waveStart) / 1000).toFixed(1);
console.log("\n[STEP 3] 完了  " + successCount + "/" + tiles.length + " solved  (" + elapsed + "s)");

// ============================================================
// 結果レポート
// ============================================================
var baselineCount = fixture.tiles.filter(function(t) { return t.status === "success"; }).length;
var baselineMap   = {};
fixture.tiles.forEach(function(t) { baselineMap[t.row + "_" + t.col] = t; });

console.log("\n" + "=".repeat(70));
console.log("結果レポート (" + MODE + ")");
console.log("=".repeat(70));
console.log("ベースライン成功数 : " + baselineCount + "/" + fixture.tiles.length);
console.log("Case B 成功数     : " + successCount  + "/" + tiles.length);
var diff = successCount - baselineCount;
console.log("差分              : " + (diff >= 0 ? "+" : "") + diff);

console.log("\nタイル別結果 (wavefront 順):");
tiles.forEach(function(t) {
    var bl  = (baselineMap[t.row + "_" + t.col] || {}).status === "success";
    var ok  = (t.status === "success");
    var tag = (bl !== ok) ? " ★変化" : "";
    var cal = "";
    if (ok && t.calibration) {
        cal = "  ra=" + t.calibration.ra.toFixed(4) +
              " dec=" + t.calibration.dec.toFixed(4) +
              " scale=" + t.calibration.pixscale.toFixed(2) + "\"/px";
    }
    console.log("  [" + t.row + "][" + t.col + "] " +
        (bl ? "base:OK" : "base:NG") + " → " + (ok ? "OK " : "NG ") + tag + cal);
});

// hint 伝播サニティーチェック:
// 各成功タイルの wcs から pixelToRaDecTD でタイル中心を逆算し、
// 初期 hintRA/hintDEC と比較することで
// "WCS から refined hint が作られているか" を可視化する
console.log("\n--- hint 伝播チェーン サニティーチェック ---");
var successTiles = tiles.filter(function(t) { return t.status === "success" && t.wcs; });
console.log("成功タイル数 (wcs あり): " + successTiles.length);

successTiles.forEach(function(t) {
    var cx = t.offsetX + t.tileWidth  / 2.0;
    var cy = t.offsetY + t.tileHeight / 2.0;
    ctx.WCS_CHK = t.wcs;
    ctx.CX_CHK  = cx;
    ctx.CY_CHK  = cy;
    var computed = null;
    try {
        computed = vm.runInContext("pixelToRaDecTD(WCS_CHK, CX_CHK, CY_CHK)", ctx);
    } catch (e) { /* ignore */ }

    if (computed && isFinite(computed[0]) && isFinite(computed[1])) {
        var initHint = t.hintRA !== undefined ? t.hintRA.toFixed(4) : "N/A";
        console.log("  [" + t.row + "][" + t.col + "]" +
            "  wcs→center: ra=" + computed[0].toFixed(4) + " dec=" + computed[1].toFixed(4) +
            "  (初期 hintRA=" + initHint + ")");
    }
});

// ============================================================
// Pass/Fail 判定
// ============================================================
console.log("\n" + "=".repeat(70));
var pass = true;

if (successCount >= baselineCount) {
    console.log("✅ 成功タイル数 ≥ ベースライン (" + successCount + " >= " + baselineCount + ")");
} else {
    console.log("❌ 成功タイル数がベースライン未満 (" + successCount + " < " + baselineCount + ")");
    pass = false;
}

if (successCount >= 1) {
    console.log("✅ 最低1タイル成功");
} else {
    console.log("❌ 全タイル失敗");
    pass = false;
}

var allWcsSet = successTiles.length > 0 &&
    successTiles.every(function(t) { return !!t.wcs; });
if (allWcsSet) {
    console.log("✅ 全成功タイルに wcs が設定されている (" + successTiles.length + " タイル)");
} else {
    console.log("⚠️  wcs が未設定の成功タイルがある");
}

console.log("=".repeat(70));
process.exit(pass ? 0 : 1);
