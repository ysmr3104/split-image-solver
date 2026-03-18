// pjsr_test_framework.js
// PJSR（PixInsight JavaScript Runtime）用テストフレームワーク
//
// 使い方:
//   var __SPLIT_SOLVER_LIBRARY_MODE = true;
//   // #include "../../javascript/SplitImageSolver.js"
//   // #include "pjsr_test_framework.js"
//
//   test("2+2は4", function() {
//       assertEqual(2 + 2, 4, "加算");
//   });
//
//   runAllTests(PROJECT_ROOT + "tests/pjsr/results/my_result.json");
//
// ログ:
//   runAllTests() 実行後、outputPath と同じディレクトリに
//   <テスト名>.log が生成される（console.writeln の全出力を含む）

(function() {

var _tests = [];
var _passed = 0;
var _failed = 0;
var _errors = [];
var _logLines = [];

// console.writeln をオーバーライドして全出力をバッファに蓄積する。
// SplitImageSolver.js 内の出力も含めて全てキャプチャできる。
var _origWriteln    = console.writeln;
var _origWarningln  = console.warningln;
var _origCriticalln = console.criticalln;

console.writeln = function(msg) {
    var s = String(msg === undefined ? "" : msg);
    _logLines.push(s);
    _origWriteln.call(console, msg);
};
console.warningln = function(msg) {
    var s = "[WARN] " + String(msg === undefined ? "" : msg);
    _logLines.push(s);
    _origWarningln.call(console, msg);
};
console.criticalln = function(msg) {
    var s = "[CRIT] " + String(msg === undefined ? "" : msg);
    _logLines.push(s);
    _origCriticalln.call(console, msg);
};

/**
 * テストを登録する
 * @param {string} name  テスト名
 * @param {function} fn  テスト本体（例外をスローすると失敗）
 */
function test(name, fn) {
    _tests.push({ name: name, fn: fn });
}

/**
 * 値が等しいことをアサートする（数値の場合は tolerance 内）
 * @param {*}      actual
 * @param {*}      expected
 * @param {string} msg        エラーメッセージ（省略可）
 * @param {number} tolerance  許容誤差（省略時 0）
 */
function assertEqual(actual, expected, msg, tolerance) {
    var tol = (typeof tolerance === "number") ? tolerance : 0;
    var ok;
    if (typeof expected === "number" && typeof actual === "number") {
        ok = Math.abs(actual - expected) <= tol;
    } else {
        ok = (actual === expected);
    }
    if (!ok) {
        var detail = (msg ? msg + ": " : "") +
            "expected=" + JSON.stringify(expected) +
            " actual=" + JSON.stringify(actual);
        throw new Error("assertEqual failed: " + detail);
    }
}

/**
 * 値が true であることをアサートする
 */
function assertTrue(val, msg) {
    if (!val) {
        throw new Error("assertTrue failed: " + (msg || JSON.stringify(val)));
    }
}

/**
 * 値が false であることをアサートする
 */
function assertFalse(val, msg) {
    if (val) {
        throw new Error("assertFalse failed: " + (msg || JSON.stringify(val)));
    }
}

/**
 * 全テストを実行し、結果を JSON ファイルとログファイルに書き出す
 * @param {string} outputPath  結果JSONファイルのフルパス
 *                             ログは同ディレクトリに <basename>.log として出力
 */
function runAllTests(outputPath) {
    _passed = 0;
    _failed = 0;
    _errors = [];

    console.writeln("=== PJSR Test Framework ===");
    console.writeln("Total tests: " + _tests.length);
    console.writeln("---------------------------");

    for (var i = 0; i < _tests.length; i++) {
        var t = _tests[i];
        try {
            t.fn();
            _passed++;
            console.writeln("  PASS: " + t.name);
        } catch (e) {
            _failed++;
            var errMsg = (e && e.message) ? e.message : String(e);
            _errors.push({ name: t.name, error: errMsg });
            console.writeln("  FAIL: " + t.name);
            console.writeln("    " + errMsg);
        }
    }

    console.writeln("---------------------------");
    console.writeln("passed=" + _passed + "  failed=" + _failed);
    console.writeln("===========================");

    // 結果ディレクトリを作成
    var dir = File.extractDrive(outputPath) + File.extractDirectory(outputPath);
    if (!File.directoryExists(dir)) {
        File.createDirectory(dir, true);
    }

    // 結果をJSONに書き出す
    var result = {
        total:  _tests.length,
        passed: _passed,
        failed: _failed,
        errors: _errors
    };
    var f = new File();
    f.createForWriting(outputPath);
    f.outText(JSON.stringify(result, null, 2));
    f.close();
    console.writeln("Result written to: " + outputPath);

    // ログファイルに全コンソール出力を書き出す
    var baseName = File.extractName(outputPath);  // e.g. "test_foo_result"
    var logPath = dir + baseName.replace(/_result$/, "") + ".log";
    var lf = new File();
    lf.createForWriting(logPath);
    lf.outText(_logLines.join("\n"));
    lf.close();
    _origWriteln.call(console, "Log written to: " + logPath);
}

// グローバルに公開
this.test        = test;
this.assertEqual = assertEqual;
this.assertTrue  = assertTrue;
this.assertFalse = assertFalse;
this.runAllTests = runAllTests;

}).call(this);
