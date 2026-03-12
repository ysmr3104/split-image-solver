#!/usr/bin/env node
/**
 * test_pipeline_local.js  (Case B: solveWavefront + solve-field 直接呼び出し)
 *
 * Local モードで solveWavefront() を実際に呼び出して
 * hint 伝播チェーン（buildTileHints → solve-field → 次タイルの refined ヒント）
 * を end-to-end で検証する。
 *
 * test_pipeline_api.js との違い:
 *   API版: solveSingleTile (astrometry.net API) を solverFn として渡す
 *   本テスト: solve-field を直接呼び出す localSolverFn を solverFn として渡す
 *
 * 前提:
 *   - /opt/homebrew/bin/solve-field (または SOLVE_FIELD_PATH) が存在すること
 *   - TILE_DIR に tile_{row}_{col}.fits が存在すること
 *   - フィクスチャ tests/javascript/fixtures/tile_wcs_api_{MODE}.json が存在すること
 *
 * 実行:
 *   node tests/javascript/test_pipeline_local.js [2x2|8x6]
 *   TILE_DIR=/path/to/tiles node tests/javascript/test_pipeline_local.js 2x2
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
var MODE            = process.argv[2] || "2x2";
var TILE_DIR        = process.env.TILE_DIR || path.join(__dirname, "../fits/" + MODE);
var SOLVE_FIELD     = process.env.SOLVE_FIELD_PATH || "/opt/homebrew/bin/solve-field";
var TIMEOUT_SEC     = parseInt(process.env.TIMEOUT_SEC || "120", 10);

if (!fs.existsSync(SOLVE_FIELD)) {
    console.error("ERROR: solve-field が見つかりません: " + SOLVE_FIELD);
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

// ============================================================
// Local ベースライン (PixInsight + solve-field の実測結果)
// API ベースライン (fixture.tiles[].status) とは異なる
// ============================================================
var LOCAL_BASELINE = {
    "2x2": {
        // 4/4 全タイル成功 (Orion, 50mm, 2x2)
        successTiles: [[0,0], [0,1], [1,0], [1,1]],
        totalSolved: 4
    },
    "8x6": {
        // 8/48 成功 (Milky Way, 14mm, 8x6)
        // テスト FITS は Python パイプライン変換品 (ルミナンス + uint16 スケーリング)
        // PI ベースラインと同じデータ変換パイプラインで生成
        successTiles: [[1,3], [1,4], [2,3], [2,4], [3,2], [3,3], [3,4], [3,5]],
        totalSolved: 8
    }
};
var localBaseline = LOCAL_BASELINE[MODE];
if (!localBaseline) {
    console.error("ERROR: LOCAL_BASELINE に " + MODE + " が定義されていません");
    process.exit(1);
}
var localBaselineMap = {};
localBaseline.successTiles.forEach(function(rc) {
    localBaselineMap[rc[0] + "_" + rc[1]] = true;
});

console.log("=".repeat(70));
console.log("Local パイプラインテスト (Case B: solveWavefront + solve-field)");
console.log("  MODE=" + MODE + "  fixture=" + FIXTURE_FILE);
console.log("  TILE_DIR=" + TILE_DIR);
console.log("  SOLVE_FIELD=" + SOLVE_FIELD);
console.log("  TIMEOUT_SEC=" + TIMEOUT_SEC);
console.log("  LOCAL_BASELINE=" + localBaseline.totalSolved + "/" + fixture.tiles.length);
console.log("=".repeat(70));

// ============================================================
// PJSR → Node.js スタブ (test_pipeline_api.js と共通)
// ============================================================
function loadSisContext() {
    var ctx = vm.createContext({
        process:       process,
        console_log:   function(s) { process.stdout.write("[SIS] " + String(s) + "\n"); }
    });

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

    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_math.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_keywords.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(jsDir, "astrometry_api.js"), "utf8"), ctx);

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

    // Node.js バインディング
    ctx.ExternalProcess = function() { this.exitCode = 0; };
    ctx.ExternalProcess.prototype.start = function(cmd, args) {
        try {
            var r = child_process.spawnSync(cmd, args || [], {
                timeout: (TIMEOUT_SEC + 30) * 1000,
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
// タイル配列の構築 (test_pipeline_api.js と同一)
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
// solve-field を直接呼び出す solverFn
// ============================================================
// readWcsFromFits は SIS context 内にあるので、Node.js 側で簡易実装
function parseWcsFromFits(fitsPath) {
    var raw;
    try {
        raw = fs.readFileSync(fitsPath, "latin1");
    } catch (e) {
        return null;
    }
    if (!raw || raw.length < 80) return null;

    var wcs = {};
    for (var pos = 0; pos + 80 <= raw.length; pos += 80) {
        var card = raw.substring(pos, pos + 80);
        var keyword = card.substring(0, 8).replace(/ +$/, "");
        if (keyword === "END") break;
        if (card.charAt(8) !== "=" || card.charAt(9) !== " ") continue;

        var valStr = card.substring(10);
        var slashIdx = valStr.indexOf("/");
        if (slashIdx >= 0) valStr = valStr.substring(0, slashIdx);
        valStr = valStr.trim().replace(/^'|'$/g, "").trim();

        switch (keyword) {
            case "CRVAL1": wcs.crval1 = parseFloat(valStr); break;
            case "CRVAL2": wcs.crval2 = parseFloat(valStr); break;
            case "CRPIX1": wcs.crpix1 = parseFloat(valStr); break;
            case "CRPIX2": wcs.crpix2 = parseFloat(valStr); break;
            case "CD1_1": wcs.cd1_1 = parseFloat(valStr); break;
            case "CD1_2": wcs.cd1_2 = parseFloat(valStr); break;
            case "CD2_1": wcs.cd2_1 = parseFloat(valStr); break;
            case "CD2_2": wcs.cd2_2 = parseFloat(valStr); break;
        }
    }

    if (wcs.crval1 === undefined || wcs.crval2 === undefined) return null;
    return wcs;
}

function buildLocalSolverFn(solveFieldPath, timeoutSec) {
    // solveWavefront の solverFn シグネチャ:
    //   solverFn(tile, tileHints, medianScale, expectedRaDec) -> bool
    return function localSolverFn(tile, tileHints, medianScale, expectedRaDec) {
        var fitsPath = tile.filePath;
        var tmpDir = os.tmpdir();
        var baseName = "sis_local_" + tile.row + "_" + tile.col;
        var tmpBase = path.join(tmpDir, baseName);

        // ダウンサンプル判定: 元タイルサイズが 2000 超なら --downsample 付与
        // (Python solver と同じロジック)
        var origLonger = Math.max(tile.tileWidth || 0, tile.tileHeight || 0);
        var downsample = 0;
        if (origLonger > 2000) {
            downsample = Math.max(2, Math.ceil(origLonger / 2000));
        }

        var args = [
            "--overwrite",
            "--no-plots",
            "--no-remove-lines",
            "--no-verify-uniformize",
            "--crpix-center",
            "--tweak-order", "4",
            "--cpulimit", String(timeoutSec),
            "--dir", tmpDir
        ];

        if (downsample > 0) {
            args.push("--downsample", String(downsample));
        }

        // スケール制約 (buildTileHints が設定した scale_lower/scale_upper を使用)
        if (tileHints.scale_lower && tileHints.scale_upper) {
            args.push("--scale-low",   String(tileHints.scale_lower));
            args.push("--scale-high",  String(tileHints.scale_upper));
            args.push("--scale-units", "arcsecperpix");
        }

        // RA/DEC 制約
        if (tileHints.center_ra !== undefined && tileHints.center_dec !== undefined) {
            args.push("--ra",     String(tileHints.center_ra));
            args.push("--dec",    String(tileHints.center_dec));
            args.push("--radius", String(tileHints.radius || 10));
        }

        args.push(fitsPath);

        // solve-field 実行
        var startMs = Date.now();
        var result;
        try {
            result = child_process.spawnSync(solveFieldPath, args, {
                timeout: (timeoutSec + 10) * 1000,
                maxBuffer: 10 * 1024 * 1024
            });
        } catch (e) {
            console.log("  solve-field exception: " + e.message);
            return false;
        }
        var elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

        if (result.status !== 0) {
            tile.status = "failed";
            console.log("  [" + tile.row + "][" + tile.col + "] solve-field failed (exit=" + result.status + ", " + elapsed + "s)");
            return false;
        }

        // .wcs ファイル確認
        // solve-field は入力ファイルの stem に基づいて出力する
        var inputStem = path.basename(fitsPath, path.extname(fitsPath));
        var wcsPath = path.join(tmpDir, inputStem + ".wcs");
        if (!fs.existsSync(wcsPath)) {
            tile.status = "failed";
            console.log("  [" + tile.row + "][" + tile.col + "] no .wcs file (" + elapsed + "s)");
            return false;
        }

        var wcsJson = parseWcsFromFits(wcsPath);
        if (!wcsJson) {
            tile.status = "failed";
            console.log("  [" + tile.row + "][" + tile.col + "] failed to parse .wcs (" + elapsed + "s)");
            return false;
        }

        // タイルオフセット・スケールファクター補正 (top-down convention)
        var sf = tile.scaleFactor || 1.0;
        tile.wcs = {
            crval1: wcsJson.crval1,
            crval2: wcsJson.crval2,
            crpix1: (wcsJson.crpix1 / sf) + tile.offsetX,
            crpix2: (wcsJson.crpix2 / sf) + tile.offsetY,
            cd1_1:  (wcsJson.cd1_1 || 0) * sf,
            cd1_2:  (wcsJson.cd1_2 || 0) * sf,
            cd2_1:  (wcsJson.cd2_1 || 0) * sf,
            cd2_2:  (wcsJson.cd2_2 || 0) * sf
        };

        // pixel_scale の計算 (CD 行列から)
        var pixscale = Math.sqrt(
            Math.abs((wcsJson.cd1_1 || 0) * (wcsJson.cd2_2 || 0) -
                     (wcsJson.cd1_2 || 0) * (wcsJson.cd2_1 || 0))
        ) * 3600.0;
        tile.calibration = {
            pixscale: pixscale,
            ra: wcsJson.crval1,
            dec: wcsJson.crval2
        };

        tile.status = "success";

        console.log("  [" + tile.row + "][" + tile.col + "] solved RA=" +
            wcsJson.crval1.toFixed(4) + " Dec=" + wcsJson.crval2.toFixed(4) +
            " scale=" + pixscale.toFixed(2) + "\"/px (" + elapsed + "s)");

        // 一時ファイル掃除
        [".wcs", ".solved", ".axy", ".corr", ".match", ".rdls", ".xyls", "-indx.xyls", ".new"].forEach(function(ext) {
            var f = path.join(tmpDir, inputStem + ext);
            try { fs.unlinkSync(f); } catch (e) {}
        });

        return true;
    };
}

// ============================================================
// メイン実行
// ============================================================
var ctx = loadSisContext();

["solveWavefront", "computeTileHints", "pixelToRaDecTD"]
    .forEach(function(fn) {
        if (typeof ctx[fn] !== "function") {
            console.error("ERROR: " + fn + " が context に見つかりません");
            process.exit(1);
        }
        console.log("  OK " + fn);
    });

var gridX   = fixture.gridX;
var gridY   = fixture.gridY;
var imgW    = fixture.imageWidth;
var imgH    = fixture.imageHeight;
var fHints  = fixture.hints;

var hints = {
    center_ra:    fHints.centerRA,
    center_dec:   fHints.centerDEC,
    scale_est:    fHints.scaleEst,
    _nativeScale: fHints.scaleEst,
    _projection:  fHints.projection || "rectilinear",
    scale_units:  "arcsecperpix",
    radius:       10,
    tweak_order:  4
};

var tiles = buildTilesFromFixture(fixture, TILE_DIR, gridX, gridY);

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
// STEP 2: solveWavefront 実行 (Case B: solve-field 直接)
// ============================================================
console.log("\n[STEP 2] solveWavefront 実行 (Case B: solve-field 直接呼び出し)...");
console.log("  -> buildTileHints が各タイルの effective scale / refined RA/DEC を計算");
console.log("  -> 解けたタイルの WCS から次のタイルの hint を改善");

// localSolverFn を context に注入
var localSolverFn = buildLocalSolverFn(SOLVE_FIELD, TIMEOUT_SEC);
ctx._localSolverFn = localSolverFn;

ctx.TILES_STEP2 = tiles;
ctx.HINTS_STEP2 = hints;
ctx.GRID_X      = gridX;
ctx.GRID_Y      = gridY;

var waveStart = Date.now();

var successCount = vm.runInContext([
    "(function(){",
    "  return solveWavefront(",
    "    null,",
    "    TILES_STEP2,",
    "    HINTS_STEP2,",
    "    IMG_W, IMG_H,",
    "    GRID_X, GRID_Y,",
    "    function(msg){ console_log(msg); },",
    "    _localSolverFn,",
    "    function(){ return false; },",
    "    function(){ return false; },",
    "    0",  // Local モードはレートリミット不要
    "  );",
    "})()"
].join("\n"), ctx);

var elapsed = ((Date.now() - waveStart) / 1000).toFixed(1);
console.log("\n[STEP 2] 完了  " + successCount + "/" + tiles.length + " solved  (" + elapsed + "s)");

// ============================================================
// 結果レポート
// ============================================================
var baselineCount = localBaseline.totalSolved;

console.log("\n" + "=".repeat(70));
console.log("結果レポート (" + MODE + ")");
console.log("=".repeat(70));
console.log("Local ベースライン : " + baselineCount + "/" + fixture.tiles.length);
console.log("Case B 成功数     : " + successCount  + "/" + tiles.length);
var diff = successCount - baselineCount;
console.log("差分              : " + (diff >= 0 ? "+" : "") + diff);

console.log("\nタイル別結果 (wavefront 順):");
tiles.forEach(function(t) {
    var bl  = !!localBaselineMap[t.row + "_" + t.col];
    var ok  = (t.status === "success");
    var tag = (bl !== ok) ? " *変化" : "";
    var cal = "";
    if (ok && t.calibration) {
        cal = "  ra=" + t.calibration.ra.toFixed(4) +
              " dec=" + t.calibration.dec.toFixed(4) +
              " scale=" + t.calibration.pixscale.toFixed(2) + "\"/px";
    }
    console.log("  [" + t.row + "][" + t.col + "] " +
        (bl ? "base:OK" : "base:NG") + " -> " + (ok ? "OK " : "NG ") + tag + cal);
});

// hint 伝播サニティーチェック
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
            "  wcs->center: ra=" + computed[0].toFixed(4) + " dec=" + computed[1].toFixed(4) +
            "  (初期 hintRA=" + initHint + ")");
    }
});

// ============================================================
// Pass/Fail 判定
// ============================================================
console.log("\n" + "=".repeat(70));
var pass = true;

// Local ベースラインと同等以上であること (リファクタリングの許容条件)
if (successCount >= baselineCount) {
    console.log("PASS: 成功タイル数 >= ベースライン (" + successCount + " >= " + baselineCount + ")");
} else {
    var regressionTiles = [];
    tiles.forEach(function(t) {
        var bl = !!localBaselineMap[t.row + "_" + t.col];
        if (bl && t.status !== "success") regressionTiles.push("[" + t.row + "][" + t.col + "]");
    });
    console.log("FAIL: 成功タイル数がベースライン未満 (" + successCount + " < " + baselineCount +
        ")  リグレッション: " + regressionTiles.join(", "));
    pass = false;
}

if (successCount >= baselineCount) {
    console.log("PASS: 成功タイル数 >= ベースライン (" + successCount + " >= " + baselineCount + ")");
} else {
    // 許容範囲内のリグレッションは警告のみ (上の閾値チェックで判定済み)
    var regressionTiles = [];
    tiles.forEach(function(t) {
        var bl = !!localBaselineMap[t.row + "_" + t.col];
        if (bl && t.status !== "success") regressionTiles.push("[" + t.row + "][" + t.col + "]");
    });
    console.log("WARN: 成功タイル数がベースライン未満 (" + successCount + " < " + baselineCount +
        ")  リグレッション: " + regressionTiles.join(", "));
}

if (successCount >= 1) {
    console.log("PASS: 最低1タイル成功");
} else {
    console.log("FAIL: 全タイル失敗");
    pass = false;
}

var allWcsSet = successTiles.length > 0 &&
    successTiles.every(function(t) { return !!t.wcs; });
if (allWcsSet) {
    console.log("PASS: 全成功タイルに wcs が設定されている (" + successTiles.length + " タイル)");
} else {
    console.log("WARN: wcs が未設定の成功タイルがある");
}

console.log("=".repeat(70));
process.exit(pass ? 0 : 1);
