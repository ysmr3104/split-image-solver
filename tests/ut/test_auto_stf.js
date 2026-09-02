//============================================================================
// test_auto_stf.js - computeAutoSTF() の Node.js 単体テスト
//
// 実行方法: node tests/ut/test_auto_stf.js
//
// 期待値は PixInsight 1.9.4 の Image.computeAutoStretch() を
// ヘッドレス実行して実測したものです。式を書き換えると必ずここで落ちます。
//============================================================================

var fs = require("fs");
var path = require("path");

var SOURCE = path.join(__dirname, "../../javascript/SplitImageSolver.js");

var passed = 0;
var failed = 0;

function assertEqual(actual, expected, msg, tolerance) {
   if (typeof tolerance === "undefined") tolerance = 0;
   var ok;
   if (tolerance > 0) {
      ok = actual !== null && Math.abs(actual - expected) <= tolerance;
   } else {
      ok = actual === expected;
   }
   if (!ok) {
      console.log("  FAIL: " + msg);
      console.log("    期待値: " + expected + ", 実際: " + actual);
      if (tolerance > 0) console.log("    許容誤差: " + tolerance);
      failed++;
   } else {
      passed++;
   }
}

function assertTrue(val, msg) {
   if (!val) {
      console.log("  FAIL: " + msg);
      failed++;
   } else {
      passed++;
   }
}

function test(name, fn) {
   console.log("[TEST] " + name);
   try {
      fn();
   } catch (e) {
      console.log("  ERROR: " + e.message);
      console.log("  " + e.stack);
      failed++;
   }
}

//============================================================================
// 検査対象の算術部分
//
// 警告: 以下は SplitImageSolver.js の computeAutoSTF() から
// 統計取得（image.median() / image.MAD()）を外したものです。
// 本体側を修正した場合はこちらも同期してください。
// 下の「本体との同期」テストが、代表的な取り違えは静的に検出します。
//============================================================================

function autoSTFFromStatistics(median, madn) {
   var targetBackground = 0.25;
   var shadowClipK = -2.8;

   var shadow = 0.0;
   if (1 + madn !== 1) {
      shadow = median + shadowClipK * madn;
      if (shadow < 0) shadow = 0;
      if (shadow > 1) shadow = 1;
   }

   var x = median - shadow;
   var m = (targetBackground - 1.0) * x /
           ((2.0 * targetBackground - 1.0) * x - targetBackground);

   return { shadowClip: shadow, midtone: m };
}

// 直したかった旧実装。回帰したときに「同じ値になってしまう」ことを検出する用。
function autoSTFLegacy(median, rawMad) {
   var mad = rawMad;
   if (mad === 0 || mad < 1e-15) {
      return { shadowClip: 0.0, midtone: 0.5 };
   }
   var targetMedian = 0.25;
   var shadowClipK = -2.8;
   var shadow = median + shadowClipK * mad;
   if (shadow < 0) shadow = 0;
   var nm = (median - shadow) / (1.0 - shadow);
   if (nm <= 0) nm = 1e-6;
   if (nm >= 1) nm = 1 - 1e-6;
   var m = (targetMedian - 1.0) * nm /
           ((2.0 * targetMedian - 1.0) * nm - targetMedian);
   if (m < 0) m = 0;
   if (m > 1) m = 1;
   return { shadowClip: shadow, midtone: m };
}

//============================================================================
// PixInsight 1.9.4 実測の基準値
//
// 採取方法:
//   img.computeAutoStretch( new Vector([median]), new Vector([1.4826*mad]),
//                           -2.80, 0.25, false )
// 戻り値は [m, c0, c1, r0, r1] の順（midtones が先）である点に注意。
//============================================================================

var MADN = 1.4826;

var REFERENCE = [
   { median: 0.01,   mad: 0.002,   shadowClip: 0.0016974400000000010,  midtone: 0.024500840601707766  },
   { median: 0.05,   mad: 0.01,    shadowClip: 0.0084872000000000090,  midtone: 0.11499118765059661   },
   { median: 0.002,  mad: 0.0005,  shadowClip: 0.0,                    midtone: 0.0059760956175298804 },
   { median: 0.2,    mad: 0.04,    shadowClip: 0.033948800000000036,   midtone: 0.37396044027846509   },
   { median: 0.0008, mad: 0.00012, shadowClip: 0.00030184640000000012, midtone: 0.0014929733399120370 },
   { median: 0.4,    mad: 0.15,    shadowClip: 0.0,                    midtone: 0.66666666666666674   },
   { median: 0.001,  mad: 0,       shadowClip: 0.0,                    midtone: 0.0029940119760479044 }
];

//============================================================================
// テスト
//============================================================================

test("PixInsight の computeAutoStretch と一致する", function () {
   for (var i = 0; i < REFERENCE.length; i++) {
      var r = REFERENCE[i];
      var got = autoSTFFromStatistics(r.median, MADN * r.mad);
      var label = "median=" + r.median + " MAD=" + r.mad;
      assertEqual(got.shadowClip, r.shadowClip, label + " の shadowClip", 1e-12);
      assertEqual(got.midtone, r.midtone, label + " の midtone", 1e-12);
   }
});

test("MAD が 0 でも midtone は median から計算する（0.5 を返さない）", function () {
   var got = autoSTFFromStatistics(0.001, 0.0);
   assertEqual(got.shadowClip, 0.0, "均一画像の shadowClip は 0", 1e-15);
   assertEqual(got.midtone, 0.0029940119760479044, "均一画像の midtone", 1e-12);
   assertTrue(got.midtone !== 0.5, "均一画像で 0.5 を返していない");
});

test("旧実装とは違う値になる（回帰の検出）", function () {
   // 生の MAD を使い、かつ (1 - shadow) で割っていたのが旧実装。
   //
   // ただし shadow が新旧とも 0 に張り付くケースでは 2 つの誤りが同時に消える。
   // 1.4826 の欠落は shadow を median 寄りにずらすだけなので、どちらも負に
   // なって 0 にクランプされれば差が出ない。さらに shadow が 0 なら
   // (1 - shadow) が 1 になり、余分な除算も無害になる。
   // これがこの不具合が長く気づかれなかった理由でもある。
   var differing = 0;
   for (var i = 0; i < REFERENCE.length; i++) {
      var r = REFERENCE[i];
      if (r.mad === 0) continue;
      var legacy = autoSTFLegacy(r.median, r.mad);
      var label = "median=" + r.median;
      if (legacy.shadowClip === 0 && r.shadowClip === 0) {
         assertEqual(legacy.midtone, r.midtone,
                     label + ": shadow が新旧とも 0 なら旧実装も正しい", 1e-12);
         continue;
      }
      assertTrue(Math.abs(legacy.shadowClip - r.shadowClip) > 1e-6,
                 label + ": 旧実装の shadowClip は基準値と異なる");
      assertTrue(Math.abs(legacy.midtone - r.midtone) > 1e-6,
                 label + ": 旧実装の midtone は基準値と異なる");
      differing++;
   }
   assertTrue(differing >= 4,
              "shadow が正のケースでは旧実装とずれる（" + differing + " 件）");
});

test("shadowClip は [0,1] に収まり median を超えない", function () {
   var medians = [0, 0.0001, 0.001, 0.01, 0.1, 0.3, 0.5, 0.9, 1.0];
   var mads = [0, 1e-9, 0.0001, 0.001, 0.01, 0.1, 0.5];
   for (var i = 0; i < medians.length; i++) {
      for (var j = 0; j < mads.length; j++) {
         var got = autoSTFFromStatistics(medians[i], MADN * mads[j]);
         var label = "median=" + medians[i] + " MAD=" + mads[j];
         assertTrue(got.shadowClip >= 0 && got.shadowClip <= 1,
                    label + ": shadowClip が [0,1] 内");
         assertTrue(got.shadowClip <= medians[i] + 1e-15,
                    label + ": shadowClip が median を超えない");
         assertTrue(got.midtone >= 0 && got.midtone <= 1,
                    label + ": midtone が [0,1] 内");
         assertTrue(isFinite(got.midtone), label + ": midtone が有限");
      }
   }
});

test("本体との同期（静的検査）", function () {
   var src = fs.readFileSync(SOURCE, "utf8");
   var fn = src.slice(src.indexOf("function computeAutoSTF(image, channel) {"));
   fn = fn.slice(0, fn.indexOf("\nfunction "));
   assertTrue(fn.length > 0, "本体の computeAutoSTF() を切り出せた");

   assertTrue(/image\.MAD\(\)\s*\*\s*1\.4826/.test(fn),
              "本体が MAD に 1.4826 を掛けている");
   assertTrue(fn.indexOf("1.0 - shadow") < 0,
              "本体に (1.0 - shadow) による除算が残っていない");
   assertTrue(fn.indexOf("avgDev") < 0,
              "本体に avgDev フォールバックが残っていない（Image.MAD() は 1.9.4 に存在する）");
   assertTrue(fn.indexOf("midtone: 0.5") < 0,
              "本体に midtone 0.5 の早期 return が残っていない");
   assertTrue(fn.indexOf("-2.8") >= 0 && fn.indexOf("0.25") >= 0,
              "本体が PixInsight の既定値 -2.8 / 0.25 を使っている");
});

//============================================================================
// 結果サマリー
//============================================================================

console.log("\n========================================");
console.log("結果: " + passed + " passed, " + failed + " failed");
console.log("========================================");

if (failed > 0) {
   process.exit(1);
}
