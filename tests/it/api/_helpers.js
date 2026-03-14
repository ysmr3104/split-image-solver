/**
 * _helpers.js — IT-API テスト共通ヘルパー
 *
 * SplitImageSolver.js を Node.js VM にロードし、
 * astrometry.net API を実際に呼び出すための共通インフラ。
 */

"use strict";

var fs            = require("fs");
var path          = require("path");
var vm            = require("vm");
var os            = require("os");
var child_process = require("child_process");

// .env ファイルから API キーを読み込む (環境変数が未設定の場合)
function loadApiKey() {
    var key = process.env.ASTROMETRY_API_KEY || "";
    if (!key) {
        var envPath = path.join(__dirname, "../../../.env");
        if (fs.existsSync(envPath)) {
            var lines = fs.readFileSync(envPath, "utf8").split("\n");
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/^ASTROMETRY_API_KEY=(.+)$/);
                if (m) { key = m[1].trim(); break; }
            }
        }
    }
    return key;
}

// SplitImageSolver.js + 依存ファイルを VM context にロード
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
        "var StdIcon_Warning=0; var StdButton_Yes=0; var StdButton_No=0;",
        "var PropertyType_String=0; var PropertyAttribute_Storable=0; var PropertyAttribute_Permanent=0; var PropertyAttribute_Protected=0;",
        "var SampleType_UInt16=0; var SampleType_Real32=0; var DataType_Float32=0; var StdCursor_Arrow=0; var StdCursor_Wait=0; var StdCursor_PointingHand=0;",
        "var TextAlign_VertCenter=0; var TextAlign_Left=0; var TextAlign_Right=0;",
        "function MessageBox(){return{execute:function(){return 0;}};}",
        "var ImageWindow={open:function(){return[];}};",
    ].join("\n"), ctx);

    var jsDir = path.join(__dirname, "../../../javascript");

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
    var TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);
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

// フィクスチャからソート済みタイル配列を構築
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

// API ログイン
function apiLogin(ctx, apiKey) {
    var TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);
    ctx.API_KEY_LOGIN = apiKey;
    ctx.TIMEOUT_LOGIN = TIMEOUT_MS;
    var loginOk = vm.runInContext([
        "(function(){",
        "  var c = new AstrometryClient(API_KEY_LOGIN);",
        "  c.timeout = TIMEOUT_LOGIN;",
        "  c.abortCheck = function(){ return false; };",
        "  c.skipCheck  = function(){ return false; };",
        "  if (!c.login()) return false;",
        "  console_log('session=' + c.session);",
        "  CLIENT = c;",
        "  return true;",
        "})()"
    ].join("\n"), ctx);
    return loginOk;
}

module.exports = {
    loadApiKey: loadApiKey,
    loadSisContext: loadSisContext,
    buildTilesFromFixture: buildTilesFromFixture,
    apiLogin: apiLogin
};
