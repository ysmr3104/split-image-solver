#!/usr/bin/env node
/**
 * test_api_integration.js
 *
 * astrometry.net API を実際に呼び出して、ヒント計算の効果を検証する統合テスト。
 *
 * 前提:
 *   1. タイルFITSファイルが TILE_DIR に存在すること
 *      (PixInsight で doSplitSolveCore の debugTileDir を設定して一度実行)
 *   2. 環境変数 ASTROMETRY_API_KEY が設定されていること
 *
 * 実行方法:
 *   ASTROMETRY_API_KEY=xxxx TILE_DIR=/path/to/tiles \
 *     node tests/javascript/test_api_integration.js [2x2|8x6]
 *
 * テスト内容:
 *   - 各タイルを新コードのヒント付きで API に送信
 *   - 成功タイル数をベースライン (フィクスチャ) と比較
 *   - [2][5] など特定タイルの成否を詳細レポート
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
var API_KEY  = process.env.ASTROMETRY_API_KEY || "";
var MODE     = process.argv[2] || "2x2";  // "2x2" or "8x6"
var TILE_DIR = process.env.TILE_DIR || path.join(__dirname, "../fits/" + MODE);

if (!API_KEY) {
    console.error("ERROR: ASTROMETRY_API_KEY 環境変数を設定してください");
    process.exit(1);
}
if (!fs.existsSync(TILE_DIR)) {
    console.error("ERROR: TILE_DIR=" + TILE_DIR + " が存在しません");
    process.exit(1);
}

var FIXTURE_FILE = MODE === "8x6"
    ? "tests/javascript/fixtures/tile_wcs_api_8x6.json"
    : "tests/javascript/fixtures/tile_wcs_api_2x2.json";

var fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

console.log("=".repeat(60));
console.log("API統合テスト: " + MODE + " / " + FIXTURE_FILE);
console.log("タイルディレクトリ: " + TILE_DIR);
console.log("=".repeat(60));

// ============================================================
// PJSR → Node.js スタブ (ExternalProcess を実際のcurlで実装)
// ============================================================
function makeNodeStubs() {
    var ExternalProcessImpl = function() {
        this.exitCode = 0;
        this._cmd = null;
        this._args = [];
    };
    ExternalProcessImpl.prototype.start = function(cmd, args) {
        this._cmd = cmd;
        this._args = args || [];
        try {
            var result = child_process.spawnSync(cmd, this._args, {
                timeout: 180000,
                maxBuffer: 10 * 1024 * 1024
            });
            this.exitCode = (result.status !== null) ? result.status : 1;
            this._result = result;
        } catch (e) {
            this.exitCode = 1;
            this._error = e;
        }
    };
    ExternalProcessImpl.prototype.waitForFinished = function(ms) {
        // start() は同期なので常に完了済み
        return this.exitCode === 0 || this.exitCode !== null;
    };
    ExternalProcessImpl.prototype.kill = function() {};

    var FileImpl = {
        systemTempDirectory: os.tmpdir(),
        exists: function(p) {
            try { fs.accessSync(p); return true; } catch (e) { return false; }
        },
        readTextFile: function(p) {
            return fs.readFileSync(p, "utf8");
        },
        writeTextFile: function(p, content) {
            fs.writeFileSync(p, content, "utf8");
        },
        remove: function(p) {
            try { fs.unlinkSync(p); } catch (e) {}
        },
        createDirectory: function(p) {
            try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
        }
    };

    return [
        "var console_log = function(s){ process.stdout.write('[API] ' + String(s) + '\\n'); };",
        "var console = { writeln: console_log, warningln: console_log, show: function(){}, criticalln: console_log, log: console_log };",
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
    ].join("\n");
}

// ============================================================
// SplitImageSolver.js をロード (wcs_math + astrometry_api 含む)
// ============================================================
function loadContext(extraStubs) {
    var ctx = vm.createContext({});
    var jsDir = path.join(__dirname, "../../javascript");

    // Node.js スタブ
    vm.runInContext(makeNodeStubs(), ctx);
    if (extraStubs) vm.runInContext(extraStubs, ctx);

    // wcs_math.js
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_math.js"), "utf8"), ctx);
    // wcs_keywords.js
    vm.runInContext(fs.readFileSync(path.join(jsDir, "wcs_keywords.js"), "utf8"), ctx);
    // astrometry_api.js
    vm.runInContext(fs.readFileSync(path.join(jsDir, "astrometry_api.js"), "utf8"), ctx);

    // SplitImageSolver.js (# 行を除去)
    var code = fs.readFileSync(path.join(jsDir, "SplitImageSolver.js"), "utf8");
    var lines = code.split("\n");
    var filtered = [], skip = false;
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (skip) { skip = !!l.match(/\\\s*$/); continue; }
        if (l.match(/^\s*#/)) { skip = !!l.match(/\\\s*$/); continue; }
        filtered.push(l);
    }
    vm.runInContext(filtered.join("\n").replace(/\nmain\(\);\s*$/, ""), ctx);

    return ctx;
}

// ExternalProcess を実際の child_process で実装して context に注入
function injectRealExternalProcess(ctx) {
    ctx.ExternalProcess = function() {
        this.exitCode = 0;
        this._cmd = null;
        this._args = [];
    };
    ctx.ExternalProcess.prototype.start = function(cmd, args) {
        this._cmd = cmd;
        this._args = args || [];
        try {
            var result = child_process.spawnSync(cmd, this._args, {
                timeout: 180000,
                maxBuffer: 10 * 1024 * 1024
            });
            this.exitCode = (result.status !== null) ? result.status : 1;
        } catch (e) {
            this.exitCode = 1;
        }
    };
    ctx.ExternalProcess.prototype.waitForFinished = function(ms) { return true; };
    ctx.ExternalProcess.prototype.kill = function() {};

    ctx.File = {
        systemTempDirectory: os.tmpdir(),
        exists: function(p) {
            try { fs.accessSync(p); return true; } catch (e) { return false; }
        },
        readTextFile: function(p) { return fs.readFileSync(p, "utf8"); },
        writeTextFile: function(p, c) { fs.writeFileSync(p, c, "utf8"); },
        remove: function(p) { try { fs.unlinkSync(p); } catch(e){} },
        createDirectory: function(p) {
            try { fs.mkdirSync(p, {recursive: true}); } catch(e){}
        }
    };
}

// ============================================================
// テスト実行
// ============================================================
var ctx = loadContext();
injectRealExternalProcess(ctx);

// APIログイン
console.log("\n[STEP 1] astrometry.net ログイン...");
var client = new ctx.AstrometryClient(API_KEY);
client.timeout = 120000;
client.abortCheck = function() { return false; };
client.skipCheck  = function() { return false; };

var loginOk = ctx.vm_run ? null : (function() {
    // AstrometryClient を context 内で動かす
    return true; // placeholder
})();

// context の中で AstrometryClient を使う必要がある
// vm.runInContext で実行する
var testCode = function(apiKey, tileDir, fixture, ctx, sis) {
    var results = [];
    var baseline = {
        success: fixture.tiles.filter(function(t){ return t.status === "success"; }).length,
        tiles: fixture.tiles.filter(function(t){ return t.status === "success"; })
    };

    // ログイン
    console.log("[API] ログイン中...");
    var client = new sis.AstrometryClient(apiKey);
    client.timeout = 120000;
    client.abortCheck = function(){ return false; };
    client.skipCheck  = function(){ return false; };
    if (!client.login()) {
        console.log("[FAIL] ログイン失敗");
        return null;
    }
    console.log("[API] ログイン成功 session=" + client.session);

    // ヒント計算
    var hints = {
        center_ra:    fixture.hints.centerRA,
        center_dec:   fixture.hints.centerDEC,
        scale_est:    fixture.hints.scaleEst,
        _nativeScale: fixture.hints.scaleEst,
        _projection:  fixture.hints.projection || "rectilinear"
    };

    var mockTiles = fixture.tiles.map(function(t) {
        return {
            row: t.row, col: t.col,
            offsetX: t.offsetX, offsetY: t.offsetY,
            tileWidth: t.tileWidth, tileHeight: t.tileHeight,
            scaleFactor: t.scaleFactor || 1.0,
            filePath: tileDir + "/tile_" + t.row + "_" + t.col + ".fits",
            status: "pending", wcs: null, calibration: null,
            hintRA: undefined, hintDEC: undefined
        };
    });

    // 存在するタイルFITSのみ対象
    var availableTiles = mockTiles.filter(function(t) {
        return fs.existsSync(t.filePath);
    });
    console.log("[INFO] 利用可能タイルFITS: " + availableTiles.length + "/" + mockTiles.length);

    if (availableTiles.length === 0) {
        console.log("[FAIL] タイルFITSが見つかりません: " + tileDir);
        return null;
    }

    // computeTileHints で初期ヒントを設定
    sis.computeTileHints(availableTiles, hints.center_ra, hints.center_dec, hints.scale_est,
        fixture.imageWidth, fixture.imageHeight, hints._projection);

    // solveWavefront の代わりに、各タイルを順番にAPIで解く
    // (wavefront順ではなくfixture順 - ヒントの有効性をフラットに評価するため)
    var fixtureWcsMap = {};
    fixture.tiles.forEach(function(t){ fixtureWcsMap[t.row+"_"+t.col] = t; });

    var successCount = 0;
    var failCount = 0;
    var tileResults = [];

    // 既に成功したタイルのWCSをaccumulateして後続タイルのヒントを改善
    var solvedSoFar = [];

    // fixture内の成功タイルをベースに、新コードのヒントで再チャレンジ
    // テスト対象: 全utilableTiles (成功・失敗問わず)
    availableTiles.forEach(function(tile) {
        var key = tile.row + "_" + tile.col;
        var baselineStatus = (fixtureWcsMap[key] && fixtureWcsMap[key].status === "success");

        // wavefrontと同様に、解決済みタイルのWCSから refined_center を計算
        var tileHints = {
            scale_units:  "arcsecperpix",
            center_ra:    tile.hintRA,
            center_dec:   tile.hintDEC,
            radius:       10,
            tweak_order:  4,
            scale_lower:  null,
            scale_upper:  null
        };

        // スケールヒント: buildTileHints と同じロジック (プロジェクション補正込み)
        if (hints.scale_est) {
            var tileCX = tile.offsetX + tile.tileWidth / 2.0;
            var tileCY = tile.offsetY + tile.tileHeight / 2.0;
            var imgCX = fixture.imageWidth / 2.0;
            var imgCY = fixture.imageHeight / 2.0;
            var rPixels = Math.sqrt((tileCX-imgCX)*(tileCX-imgCX) + (tileCY-imgCY)*(tileCY-imgCY));
            var maxR = Math.sqrt(imgCX*imgCX + imgCY*imgCY);
            var margin = 0.2 + 0.3 * (rPixels / maxR);
            // プロジェクション補正 (rectilinear/gnomonic): nativeScale * (1/cos^2(theta)) / scaleFactor
            var nativeScale = hints.scale_est;
            var scaleRad = (nativeScale / 3600.0) * Math.PI / 180.0;
            var rScaled = rPixels * scaleRad;
            var theta = Math.atan(rScaled); // rectilinear
            var factor = (theta > 0.001) ? (1.0 / (Math.cos(theta) * Math.cos(theta))) : 1.0;
            var effectiveScale = nativeScale * factor / (tile.scaleFactor || 1.0);
            tileHints.scale_lower = effectiveScale * (1.0 - margin);
            tileHints.scale_upper = effectiveScale * (1.0 + margin);
        }

        // 解決済みタイルからrefined_center
        if (solvedSoFar.length > 0) {
            var tileCXr = tile.offsetX + tile.tileWidth / 2.0;
            var tileCYr = tile.offsetY + tile.tileHeight / 2.0;
            var nearest = null, minD2 = Infinity;
            solvedSoFar.forEach(function(s) {
                var scx = s.offsetX + s.tileWidth/2.0;
                var scy = s.offsetY + s.tileHeight/2.0;
                var d2 = (tileCXr-scx)*(tileCXr-scx) + (tileCYr-scy)*(tileCYr-scy);
                if (d2 < minD2) { minD2=d2; nearest=s; }
            });
            if (nearest && nearest.wcs) {
                var refined = sis.pixelToRaDecTD(nearest.wcs, tileCXr, tileCYr);
                if (refined && isFinite(refined[0]) && isFinite(refined[1])) {
                    tileHints.center_ra  = refined[0];
                    tileHints.center_dec = refined[1];
                    if (tileHints.scale_lower && tileHints.scale_upper) {
                        var mid = (tileHints.scale_lower + tileHints.scale_upper) / 2.0;
                        tileHints.scale_lower = mid * 0.5;
                        tileHints.scale_upper = mid * 1.5;
                    }
                }
            }
        }

        console.log("\n[TILE " + tile.row + "][" + tile.col + "] " +
            (baselineStatus ? "(baseline:success)" : "(baseline:fail)"));
        console.log("  hints: center_ra=" +
            (tileHints.center_ra !== undefined ? tileHints.center_ra.toFixed(4) : "none") +
            " center_dec=" +
            (tileHints.center_dec !== undefined ? tileHints.center_dec.toFixed(4) : "none"));
        console.log("  scale: [" +
            (tileHints.scale_lower ? tileHints.scale_lower.toFixed(1) : "-") + " - " +
            (tileHints.scale_upper ? tileHints.scale_upper.toFixed(1) : "-") + "]\"/px");

        var solved = sis.solveSingleTile(client, tile, tileHints, 0, null);

        var rec = {
            row: tile.row, col: tile.col,
            baselineSuccess: baselineStatus,
            success: solved,
            calibration: tile.calibration || null,
            wcs: tile.wcs || null
        };
        tileResults.push(rec);

        if (solved) {
            successCount++;
            solvedSoFar.push(tile);
            console.log("  → SOLVED: ra=" + tile.calibration.ra.toFixed(4) +
                " dec=" + tile.calibration.dec.toFixed(4) +
                " scale=" + tile.calibration.pixscale.toFixed(2) + "\"/px");
        } else {
            failCount++;
            console.log("  → FAILED");
        }
    });

    return {
        successCount: successCount,
        failCount: failCount,
        baselineCount: baseline.success,
        tileResults: tileResults
    };
};

// solveSingleTile が context 内で定義されているか確認してから実行
console.log("[INFO] solveSingleTile: " + typeof ctx.solveSingleTile);
console.log("[INFO] computeTileHints: " + typeof ctx.computeTileHints);
console.log("[INFO] pixelToRaDecTD: " + typeof ctx.pixelToRaDecTD);
console.log("[INFO] AstrometryClient: " + typeof ctx.AstrometryClient);

// context 外の fs を渡すために、グローバルに注入
ctx.fs = fs;
ctx.TILE_DIR = TILE_DIR;
ctx.FIXTURE  = fixture;
ctx.API_KEY  = API_KEY;
ctx.process  = process;

// テスト本体をcontextで実行
var scriptSrc = "(" + testCode.toString() + ")(API_KEY, TILE_DIR, FIXTURE, {}, {" +
    "AstrometryClient: AstrometryClient," +
    "computeTileHints: computeTileHints," +
    "solveSingleTile: solveSingleTile," +
    "pixelToRaDecTD: pixelToRaDecTD" +
    "})";

try {
    var result = vm.runInContext(scriptSrc, ctx);

    if (!result) {
        console.log("\n[FAIL] テスト実行失敗");
        process.exit(1);
    }

    // ============================================================
    // 結果レポート
    // ============================================================
    console.log("\n" + "=".repeat(60));
    console.log("結果サマリー (" + MODE + ")");
    console.log("=".repeat(60));
    console.log("ベースライン成功タイル数: " + result.baselineCount);
    console.log("新コード成功タイル数:     " + result.successCount);
    var diff = result.successCount - result.baselineCount;
    console.log("差分: " + (diff >= 0 ? "+" : "") + diff);

    console.log("\nタイル別結果:");
    console.log("  [row][col]  baseline → 新コード");
    result.tileResults.forEach(function(r) {
        var bl = r.baselineSuccess ? "SUCCESS" : "FAIL   ";
        var nw = r.success         ? "SUCCESS" : "FAIL   ";
        var changed = (r.baselineSuccess !== r.success) ? " ★変化!" : "";
        console.log("  [" + r.row + "][" + r.col + "]  " + bl + " → " + nw + changed);
    });

    if (result.successCount >= result.baselineCount) {
        console.log("\n✅ 成功タイル数はベースライン以上 (精度劣化なし)");
    } else {
        console.log("\n⚠️  成功タイル数がベースラインより減少 (要調査)");
    }

} catch (e) {
    console.log("[FAIL] 例外: " + e);
    console.log(e.stack);
    process.exit(1);
}
