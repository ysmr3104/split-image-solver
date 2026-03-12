#!/usr/bin/env node
/**
 * [2][2] 単体 API solve テスト
 * ベースラインのヒント値を使って Python 変換 FITS が API で解けるか確認
 */
"use strict";

var fs            = require("fs");
var path          = require("path");
var vm            = require("vm");
var os            = require("os");
var child_process = require("child_process");

var API_KEY    = process.env.ASTROMETRY_API_KEY || "";
var TIMEOUT_MS = 120000;

if (!API_KEY) { console.error("ERROR: ASTROMETRY_API_KEY 必須"); process.exit(1); }

// ベースラインの値
var BASELINE_HINT_RA  = 299.5509082819316;
var BASELINE_HINT_DEC = -9.219163390440292;
var BASELINE_RA       = 287.3191745794308;
var BASELINE_DEC      = 4.888765360409685;
var BASELINE_SCALE    = 49.13662218171431;

// --- SIS context 構築 (test_pipeline_api.js の loadSisContext と同一) ---
var ctx = vm.createContext({
    console_log: function(m) { console.log(m); },
    console: console, Math: Math, JSON: JSON,
    parseInt: parseInt, parseFloat: parseFloat,
    isFinite: isFinite, isNaN: isNaN, Date: Date
});

vm.runInContext([
    "var Parameters={has:function(){return false;},getString:function(){return '';},getInteger:function(){return 0;},getReal:function(){return 0;},getBoolean:function(){return false;}};",
    "var console={writeln:function(m){console_log(m);},write:function(m){},flush:function(){},show:function(){},hide:function(){},warningln:function(m){console_log('WARN: '+m);},noteln:function(m){console_log('NOTE: '+m);},criticalln:function(m){console_log('CRIT: '+m);}};",
    "var CoreApplication={executingScriptPath:'/test'};",
    "var File={systemTempDirectory:'" + os.tmpdir().replace(/\\/g,"\\\\") + "'};",
    "var processEvents = function(){};",
    "var msleep = function(ms){ var end = Date.now()+ms; while(Date.now()<end){} };",
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

ctx.ExternalProcess = function() { this.exitCode = 0; };
ctx.ExternalProcess.prototype.start = function(cmd, args) {
    try { var r = child_process.spawnSync(cmd, args || [], { timeout: TIMEOUT_MS + 30000, maxBuffer: 10*1024*1024 }); this.exitCode = (r.status !== null) ? r.status : 1; } catch(e) { this.exitCode = 1; }
};
ctx.ExternalProcess.prototype.waitForFinished = function() { return true; };
ctx.ExternalProcess.prototype.kill = function() {};
ctx.File = {
    systemTempDirectory: os.tmpdir(),
    exists:          function(p) { try { fs.accessSync(p); return true; } catch(e) { return false; } },
    readTextFile:    function(p) { return fs.readFileSync(p, "utf8"); },
    writeTextFile:   function(p, c) { fs.writeFileSync(p, c, "utf8"); },
    remove:          function(p) { try { fs.unlinkSync(p); } catch(e) {} },
    createDirectory: function(p) { try { fs.mkdirSync(p, { recursive: true }); } catch(e) {} }
};

// ログイン
ctx.API_KEY_S = API_KEY;
ctx.TIMEOUT_S = TIMEOUT_MS;
var loginOk = vm.runInContext([
    "(function(){",
    "  var c = new AstrometryClient(API_KEY_S);",
    "  c.timeout = TIMEOUT_S;",
    "  c.abortCheck = function(){return false;};",
    "  c.skipCheck  = function(){return false;};",
    "  if (!c.login()) return false;",
    "  console_log('session=' + c.session);",
    "  CLIENT = c;",
    "  return true;",
    "})()"
].join("\n"), ctx);
if (!loginOk) { console.error("ログイン失敗"); process.exit(1); }
console.log("ログイン成功\n");

// テスト: ベースラインのヒントで [2][2] を solve
var tileFilePython = path.join(__dirname, "../fits/8x6/tile_2_2.fits");
var tileFileOrig   = "/tmp/tile_2_2_orig.fits";
var tileFile = tileFilePython;  // Python 変換 FITS
console.log("=== テスト: [2][2] ベースラインヒント (RA=" + BASELINE_HINT_RA.toFixed(4) + " DEC=" + BASELINE_HINT_DEC.toFixed(4) + ") ===");
ctx.TILE1 = {
    filePath: tileFile, col: 2, row: 2,
    offsetX: 2332, offsetY: 2118, tileWidth: 1416, tileHeight: 1309, scaleFactor: 1,
    origOffsetX: 2332, origOffsetY: 2118, origTileWidth: 1416, origTileHeight: 1309,
    wcs: null, calibration: null, status: "pending",
    hintRA: BASELINE_HINT_RA, hintDEC: BASELINE_HINT_DEC
};
ctx.HINTS1 = {
    center_ra: BASELINE_HINT_RA, center_dec: BASELINE_HINT_DEC,
    scale_est: BASELINE_SCALE, _nativeScale: BASELINE_SCALE, _projection: "rectilinear",
    scale_units: "arcsecperpix", scale_lower: 35.0, scale_upper: 104.9,
    radius: 10, tweak_order: 4
};
var t0 = Date.now();
vm.runInContext("(function(){ solveSingleTile(CLIENT, TILE1, HINTS1, " + BASELINE_SCALE + ", {ra:" + BASELINE_HINT_RA + ", dec:" + BASELINE_HINT_DEC + "}); })()", ctx);
var elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
console.log("  status: " + ctx.TILE1.status + "  (" + elapsed1 + "s)");
if (ctx.TILE1.calibration) {
    console.log("  ra=" + ctx.TILE1.calibration.ra.toFixed(4) + " dec=" + ctx.TILE1.calibration.dec.toFixed(4) + " scale=" + ctx.TILE1.calibration.pixscale.toFixed(2) + "\"/px");
}

// テスト2: ベースラインの解の値をヒントにして solve
console.log("\n=== テスト2: [2][2] ベースライン解の値をヒントに (RA=" + BASELINE_RA.toFixed(4) + " DEC=" + BASELINE_DEC.toFixed(4) + ") ===");
ctx.TILE2 = {
    filePath: tileFile, col: 2, row: 2,
    offsetX: 2332, offsetY: 2118, tileWidth: 1416, tileHeight: 1309, scaleFactor: 1,
    origOffsetX: 2332, origOffsetY: 2118, origTileWidth: 1416, origTileHeight: 1309,
    wcs: null, calibration: null, status: "pending",
    hintRA: BASELINE_RA, hintDEC: BASELINE_DEC
};
ctx.HINTS2 = {
    center_ra: BASELINE_RA, center_dec: BASELINE_DEC,
    scale_est: BASELINE_SCALE, _nativeScale: BASELINE_SCALE, _projection: "rectilinear",
    scale_units: "arcsecperpix", scale_lower: 35.0, scale_upper: 104.9,
    radius: 10, tweak_order: 4
};
var t1 = Date.now();
vm.runInContext("(function(){ solveSingleTile(CLIENT, TILE2, HINTS2, " + BASELINE_SCALE + ", {ra:" + BASELINE_RA + ", dec:" + BASELINE_DEC + "}); })()", ctx);
var elapsed2 = ((Date.now() - t1) / 1000).toFixed(1);
console.log("  status: " + ctx.TILE2.status + "  (" + elapsed2 + "s)");
if (ctx.TILE2.calibration) {
    console.log("  ra=" + ctx.TILE2.calibration.ra.toFixed(4) + " dec=" + ctx.TILE2.calibration.dec.toFixed(4) + " scale=" + ctx.TILE2.calibration.pixscale.toFixed(2) + "\"/px");
}
