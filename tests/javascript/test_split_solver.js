//============================================================================
// test_split_solver.js - SplitImageSolver 単体テスト
//
// 実行方法: node tests/javascript/test_split_solver.js
//
// SplitImageSolver.js の純粋関数を Node.js でテスト。
// 振る舞い検証: 入力→出力の結果のみを検証し、内部実装には依存しない。
//============================================================================

var passed = 0;
var failed = 0;

function assertEqual(actual, expected, msg, tolerance) {
   if (typeof tolerance === "undefined") tolerance = 0;
   var ok;
   if (expected === null) {
      ok = actual === null;
   } else if (tolerance > 0) {
      ok = actual !== null && Math.abs(actual - expected) <= tolerance;
   } else {
      ok = actual === expected;
   }
   if (!ok) {
      console.log("  FAIL: " + msg);
      console.log("    expected: " + expected + ", actual: " + actual);
      if (tolerance > 0) console.log("    tolerance: " + tolerance);
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

function assertFalse(val, msg) {
   if (val) {
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
// テスト対象関数（SplitImageSolver.js から抽出）
//============================================================================

function raToHMS(raDeg) {
   var ra = raDeg;
   while (ra < 0) ra += 360.0;
   while (ra >= 360) ra -= 360.0;
   var totalSec = ra / 15.0 * 3600.0;
   var h = Math.floor(totalSec / 3600.0);
   totalSec -= h * 3600.0;
   var m = Math.floor(totalSec / 60.0);
   var s = totalSec - m * 60.0;
   var hStr = (h < 10 ? "0" : "") + h;
   var mStr = (m < 10 ? "0" : "") + m;
   var sStr = (s < 10 ? "0" : "") + s.toFixed(2);
   return hStr + " " + mStr + " " + sStr;
}

function decToDMS(decDeg) {
   var sign = decDeg >= 0 ? "+" : "-";
   var dec = Math.abs(decDeg);
   var totalSec = dec * 3600.0;
   var d = Math.floor(totalSec / 3600.0);
   totalSec -= d * 3600.0;
   var m = Math.floor(totalSec / 60.0);
   var s = totalSec - m * 60.0;
   var dStr = (d < 10 ? "0" : "") + d;
   var mStr = (m < 10 ? "0" : "") + m;
   var sStr = (s < 10 ? "0" : "") + s.toFixed(1);
   return sign + dStr + " " + mStr + " " + sStr;
}

function parseRAInput(text) {
   if (typeof text !== "string") return null;
   text = text.trim();
   if (text.length === 0) return null;
   var parts = text.split(/[\s:]+/);
   if (parts.length >= 3) {
      var h = parseFloat(parts[0]);
      var m = parseFloat(parts[1]);
      var s = parseFloat(parts[2]);
      if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
         return (h + m / 60.0 + s / 3600.0) * 15.0;
      }
   }
   var val = parseFloat(text);
   if (!isNaN(val)) return val;
   return null;
}

function parseDECInput(text) {
   if (typeof text !== "string") return null;
   text = text.trim();
   if (text.length === 0) return null;
   var sign = 1;
   if (text.charAt(0) === "-") {
      sign = -1;
      text = text.substring(1);
   } else if (text.charAt(0) === "+") {
      text = text.substring(1);
   }
   var parts = text.split(/[\s:]+/);
   if (parts.length >= 3) {
      var d = parseFloat(parts[0]);
      var m = parseFloat(parts[1]);
      var s = parseFloat(parts[2]);
      if (!isNaN(d) && !isNaN(m) && !isNaN(s)) {
         return sign * (d + m / 60.0 + s / 3600.0);
      }
   }
   var val = parseFloat(text);
   if (!isNaN(val)) return sign * val;
   return null;
}

function formatElapsed(ms) {
   var sec = Math.floor(ms / 1000);
   var min = Math.floor(sec / 60);
   sec = sec % 60;
   var secStr = (sec < 10 ? "0" : "") + sec;
   return min + ":" + secStr;
}

function projectionScale(projection, baseScale, thetaDeg) {
   var theta = thetaDeg * Math.PI / 180.0;
   if (theta < 0.001) return baseScale;
   switch (projection) {
      case "rectilinear":
         var cosT = Math.cos(theta);
         if (Math.abs(cosT) < 1e-6) return baseScale * 1000;
         return baseScale / (cosT * cosT);
      case "equisolid":
         return baseScale / Math.cos(theta / 2.0);
      case "equidistant":
         return baseScale;
      case "stereographic":
         var cosHalf = Math.cos(theta / 2.0);
         return baseScale / (cosHalf * cosHalf);
      default:
         return baseScale;
   }
}

function tileAngleFromCenter(tileCenterX, tileCenterY, imageCenterX, imageCenterY, pixelScaleArcsec) {
   var dx = tileCenterX - imageCenterX;
   var dy = tileCenterY - imageCenterY;
   var distPx = Math.sqrt(dx * dx + dy * dy);
   return distPx * pixelScaleArcsec / 3600.0;
}

function computePixelScale(pixelPitchUm, focalLengthMm) {
   if (pixelPitchUm <= 0 || focalLengthMm <= 0) return 0;
   return 206.265 * pixelPitchUm / focalLengthMm;
}

function computeDiagonalFov(sensorWidthPx, sensorHeightPx, pixelScaleArcsec) {
   if (pixelScaleArcsec <= 0) return 0;
   var diagPx = Math.sqrt(sensorWidthPx * sensorWidthPx + sensorHeightPx * sensorHeightPx);
   var halfDiagRad = diagPx * pixelScaleArcsec / 2.0 / 206265.0;
   return 2.0 * Math.atan(halfDiagRad) * 180.0 / Math.PI;
}

function recommendGrid(diagFovDeg, imageWidth, imageHeight) {
   if (diagFovDeg <= 0) return { cols: 1, rows: 1, reason: "FOV unknown" };
   if (diagFovDeg <= 10) return { cols: 1, rows: 1, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV - single solve" };
   if (diagFovDeg <= 20) return { cols: 2, rows: 2, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 40) return { cols: 3, rows: 2, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 60) return { cols: 4, rows: 3, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 90) return { cols: 6, rows: 4, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 120) return { cols: 8, rows: 6, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   return { cols: 12, rows: 8, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV (full-sky)" };
}

function findGridPresetIndex(presets, cols, rows) {
   for (var i = 0; i < presets.length; i++) {
      if (presets[i][0] === cols && presets[i][1] === rows) return i;
   }
   return -1;
}

function convertToWcsResult(wcs, imageWidth, imageHeight) {
   var result = {
      crval1: wcs.crval1,
      crval2: wcs.crval2,
      crpix1: wcs.crpix1,
      crpix2: wcs.crpix2,
      cd: [[wcs.cd1_1 || 0, wcs.cd1_2 || 0], [wcs.cd2_1 || 0, wcs.cd2_2 || 0]],
      sip: null,
      sipMode: null
   };
   if (wcs.sipCoeffs && wcs.aOrder) {
      result.sip = {
         order: wcs.aOrder,
         a: wcs.sipCoeffs.a || [],
         b: wcs.sipCoeffs.b || [],
         ap: wcs.sipCoeffs.ap || null,
         bp: wcs.sipCoeffs.bp || null,
         invOrder: wcs.apOrder || wcs.aOrder
      };
      result.sipMode = "approx";
   }
   return result;
}

//============================================================================
// wcs_math.js から必要な関数（pixelToRaDec, angularSeparation のテスト用）
//============================================================================

function tanDeproject(crval, xieta) {
   var xi = xieta[0] * Math.PI / 180.0;
   var eta = xieta[1] * Math.PI / 180.0;
   var ra0 = crval[0] * Math.PI / 180.0;
   var dec0 = crval[1] * Math.PI / 180.0;
   var sinDec0 = Math.sin(dec0);
   var cosDec0 = Math.cos(dec0);
   var denom = cosDec0 - eta * sinDec0;
   var ra = ra0 + Math.atan2(xi, denom);
   var dec = Math.atan2(sinDec0 + eta * cosDec0, Math.sqrt(xi * xi + denom * denom));
   ra = ra * 180.0 / Math.PI;
   dec = dec * 180.0 / Math.PI;
   while (ra < 0) ra += 360.0;
   while (ra >= 360) ra -= 360.0;
   return [ra, dec];
}

function evalSipPolynomial(coeffs, u, v) {
   if (!coeffs) return 0;
   var sum = 0;
   for (var i = 0; i < coeffs.length; i++) {
      var row = coeffs[i];
      if (!row) continue;
      for (var j = 0; j < row.length; j++) {
         if (row[j] && row[j] !== 0) {
            sum += row[j] * Math.pow(u, i) * Math.pow(v, j);
         }
      }
   }
   return sum;
}

function pixelToRaDec(wcs, px, py, imageHeight) {
   var u = (px + 1.0) - wcs.crpix1;
   var v = (imageHeight - py) - wcs.crpix2;
   var up = u, vp = v;
   if (wcs.sip) {
      up = u + evalSipPolynomial(wcs.sip.a, u, v);
      vp = v + evalSipPolynomial(wcs.sip.b, u, v);
   }
   var xi  = wcs.cd1_1 * up + wcs.cd1_2 * vp;
   var eta = wcs.cd2_1 * up + wcs.cd2_2 * vp;
   return tanDeproject([wcs.crval1, wcs.crval2], [xi, eta]);
}

function angularSeparation(rd1, rd2) {
   var ra1 = rd1[0] * Math.PI / 180;
   var dec1 = rd1[1] * Math.PI / 180;
   var ra2 = rd2[0] * Math.PI / 180;
   var dec2 = rd2[1] * Math.PI / 180;
   var dra = ra2 - ra1;
   var a = Math.sin((dec2 - dec1) / 2);
   var b = Math.sin(dra / 2);
   var c = a * a + Math.cos(dec1) * Math.cos(dec2) * b * b;
   return 2 * Math.asin(Math.sqrt(c)) * 180 / Math.PI;
}

// validateOverlap 用 - console.writeln stub
var console_writeln_orig = console.log;
if (typeof console.writeln === "undefined") {
   console.writeln = function() {};
}

function validateOverlap(tiles, imageWidth, imageHeight, toleranceArcsec) {
   if (typeof toleranceArcsec === "undefined") toleranceArcsec = 5.0;
   var successTiles = [];
   for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].status === "success" && tiles[i].wcs) successTiles.push(tiles[i]);
   }
   if (successTiles.length < 2) return 0;
   var deviations = [];
   for (var i = 0; i < successTiles.length; i++) {
      deviations.push({ idx: i, maxDev: 0, pairCount: 0, totalDev: 0 });
   }
   var pairsChecked = 0;
   for (var i = 0; i < successTiles.length; i++) {
      for (var j = i + 1; j < successTiles.length; j++) {
         var ti = successTiles[i];
         var tj = successTiles[j];
         var iX0 = ti.offsetX, iX1 = ti.offsetX + ti.tileWidth;
         var iY0 = ti.offsetY, iY1 = ti.offsetY + ti.tileHeight;
         var jX0 = tj.offsetX, jX1 = tj.offsetX + tj.tileWidth;
         var jY0 = tj.offsetY, jY1 = tj.offsetY + tj.tileHeight;
         var overlapX0 = Math.max(iX0, jX0);
         var overlapX1 = Math.min(iX1, jX1);
         var overlapY0 = Math.max(iY0, jY0);
         var overlapY1 = Math.min(iY1, jY1);
         if (overlapX0 >= overlapX1 || overlapY0 >= overlapY1) continue;
         var maxDev = 0;
         var SAMPLE = 3;
         for (var sy = 0; sy < SAMPLE; sy++) {
            for (var sx = 0; sx < SAMPLE; sx++) {
               var px = overlapX0 + (sx + 0.5) * (overlapX1 - overlapX0) / SAMPLE;
               var py = overlapY0 + (sy + 0.5) * (overlapY1 - overlapY0) / SAMPLE;
               var wcsI = {
                  crval1: ti.wcs.crval1, crval2: ti.wcs.crval2,
                  crpix1: ti.wcs.crpix1, crpix2: ti.wcs.crpix2,
                  cd1_1: ti.wcs.cd1_1 || 0, cd1_2: ti.wcs.cd1_2 || 0,
                  cd2_1: ti.wcs.cd2_1 || 0, cd2_2: ti.wcs.cd2_2 || 0,
                  sip: null
               };
               var wcsJ = {
                  crval1: tj.wcs.crval1, crval2: tj.wcs.crval2,
                  crpix1: tj.wcs.crpix1, crpix2: tj.wcs.crpix2,
                  cd1_1: tj.wcs.cd1_1 || 0, cd1_2: tj.wcs.cd1_2 || 0,
                  cd2_1: tj.wcs.cd2_1 || 0, cd2_2: tj.wcs.cd2_2 || 0,
                  sip: null
               };
               var rdI = pixelToRaDec(wcsI, px, py, imageHeight);
               var rdJ = pixelToRaDec(wcsJ, px, py, imageHeight);
               if (!rdI || !rdJ) continue;
               var dev = angularSeparation(rdI, rdJ) * 3600.0;
               if (dev > maxDev) maxDev = dev;
            }
         }
         deviations[i].totalDev += maxDev;
         deviations[i].pairCount++;
         deviations[j].totalDev += maxDev;
         deviations[j].pairCount++;
         if (maxDev > deviations[i].maxDev) deviations[i].maxDev = maxDev;
         if (maxDev > deviations[j].maxDev) deviations[j].maxDev = maxDev;
         pairsChecked++;
      }
   }
   var invalidated = 0;
   for (var i = 0; i < successTiles.length; i++) {
      if (deviations[i].pairCount === 0) continue;
      var avgDev = deviations[i].totalDev / deviations[i].pairCount;
      if (avgDev > toleranceArcsec * 3) {
         successTiles[i].status = "failed";
         successTiles[i].wcs = null;
         invalidated++;
      }
   }
   return invalidated;
}

//============================================================================
// テスト
//============================================================================

// ---- 座標フォーマット ----

test("raToHMS: 0度 → 00 00 00.00", function() {
   assertEqual(raToHMS(0), "00 00 00.00", "RA=0");
});

test("raToHMS: 180度 → 12 00 00.00", function() {
   assertEqual(raToHMS(180), "12 00 00.00", "RA=180");
});

test("raToHMS: 負の値は正規化される", function() {
   assertEqual(raToHMS(-15), raToHMS(345), "RA=-15 == RA=345");
});

test("raToHMS: M31 (RA=10.6847°) → 00 42 44.33", function() {
   var result = raToHMS(10.6847);
   assertTrue(result.startsWith("00 42 44"), "M31 RA format: " + result);
});

test("decToDMS: 0度 → +00 00 00.0", function() {
   assertEqual(decToDMS(0), "+00 00 00.0", "DEC=0");
});

test("decToDMS: 負の値", function() {
   assertTrue(decToDMS(-45.5).startsWith("-45 30"), "DEC=-45.5: " + decToDMS(-45.5));
});

test("decToDMS: M31 (DEC=+41.2687°)", function() {
   var result = decToDMS(41.2687);
   assertTrue(result.startsWith("+41 16"), "M31 DEC format: " + result);
});

// ---- 座標パース ----

test("parseRAInput: HMS スペース区切り", function() {
   // 06 45 08.92 = (6 + 45/60 + 8.92/3600) * 15 = 101.2872 deg
   var result = parseRAInput("06 45 08.92");
   assertEqual(result, 101.28716667, "HMS space", 0.001);
});

test("parseRAInput: HMS コロン区切り", function() {
   var result = parseRAInput("06:45:08.92");
   assertEqual(result, 101.28716667, "HMS colon", 0.001);
});

test("parseRAInput: 度数直接入力", function() {
   assertEqual(parseRAInput("180.5"), 180.5, "degrees");
});

test("parseRAInput: 空文字 → null", function() {
   assertEqual(parseRAInput(""), null, "empty");
});

test("parseRAInput: 非数値 → null", function() {
   assertEqual(parseRAInput("abc"), null, "non-numeric");
});

test("parseDECInput: DMS 正の値", function() {
   // +41 16 07.50 = 41 + 16/60 + 7.5/3600 = 41.26875 deg
   var result = parseDECInput("+41 16 07.50");
   assertEqual(result, 41.26875, "DMS positive", 0.001);
});

test("parseDECInput: DMS 負の値", function() {
   var result = parseDECInput("-16 42 58.00");
   assertTrue(result < 0, "negative: " + result);
   assertEqual(result, -16.716111, "DMS negative", 0.001);
});

test("parseDECInput: コロン区切り", function() {
   var result = parseDECInput("-16:42:58.00");
   assertEqual(result, -16.716111, "DMS colon", 0.001);
});

test("parseDECInput: 度数直接入力", function() {
   assertEqual(parseDECInput("-45.5"), -45.5, "degrees");
});

test("parseDECInput: 符号なし → 正", function() {
   assertEqual(parseDECInput("41 16 07.50"), 41.26875, "no sign", 0.001);
});

// ---- RA/DEC ラウンドトリップ ----

test("raToHMS → parseRAInput ラウンドトリップ", function() {
   var original = 83.6331;
   var hms = raToHMS(original);
   var roundtripped = parseRAInput(hms);
   assertEqual(roundtripped, original, "RA roundtrip", 0.01);
});

test("decToDMS → parseDECInput ラウンドトリップ", function() {
   var original = -5.3911;
   var dms = decToDMS(original);
   var roundtripped = parseDECInput(dms);
   assertEqual(roundtripped, original, "DEC roundtrip", 0.01);
});

// ---- formatElapsed ----

test("formatElapsed: 0ms → 0:00", function() {
   assertEqual(formatElapsed(0), "0:00", "0ms");
});

test("formatElapsed: 65000ms → 1:05", function() {
   assertEqual(formatElapsed(65000), "1:05", "65s");
});

test("formatElapsed: 3661000ms → 61:01", function() {
   assertEqual(formatElapsed(3661000), "61:01", "61min");
});

// ---- projectionScale ----

test("projectionScale: 中心では全投影型が同じスケール", function() {
   var base = 2.0;
   assertEqual(projectionScale("rectilinear", base, 0), base, "rectilinear at center");
   assertEqual(projectionScale("equisolid", base, 0), base, "equisolid at center");
   assertEqual(projectionScale("equidistant", base, 0), base, "equidistant at center");
   assertEqual(projectionScale("stereographic", base, 0), base, "stereographic at center");
});

test("projectionScale: equidistant は角度によらず一定", function() {
   var base = 2.0;
   assertEqual(projectionScale("equidistant", base, 30), base, "equidistant at 30deg");
   assertEqual(projectionScale("equidistant", base, 60), base, "equidistant at 60deg");
});

test("projectionScale: rectilinear は角度が増すとスケール増大", function() {
   var base = 2.0;
   var at30 = projectionScale("rectilinear", base, 30);
   var at60 = projectionScale("rectilinear", base, 60);
   assertTrue(at30 > base, "rectilinear 30deg > center: " + at30);
   assertTrue(at60 > at30, "rectilinear 60deg > 30deg: " + at60);
   // 30° → 1/cos²(30°) = 1/0.75 ≈ 1.333
   assertEqual(at30, base / (Math.cos(30 * Math.PI / 180) * Math.cos(30 * Math.PI / 180)), "rectilinear 30deg formula", 0.001);
});

test("projectionScale: equisolid は rectilinear より緩やかに増大", function() {
   var base = 2.0;
   var recti45 = projectionScale("rectilinear", base, 45);
   var equis45 = projectionScale("equisolid", base, 45);
   assertTrue(equis45 > base, "equisolid 45deg > center: " + equis45);
   assertTrue(equis45 < recti45, "equisolid < rectilinear at 45deg: " + equis45 + " < " + recti45);
});

test("projectionScale: stereographic は equisolid と rectilinear の中間", function() {
   var base = 2.0;
   var recti30 = projectionScale("rectilinear", base, 30);
   var equis30 = projectionScale("equisolid", base, 30);
   var stereo30 = projectionScale("stereographic", base, 30);
   assertTrue(stereo30 > equis30, "stereo > equisolid at 30deg");
   assertTrue(stereo30 < recti30, "stereo < rectilinear at 30deg");
});

test("projectionScale: 不明な投影型はベーススケールを返す", function() {
   assertEqual(projectionScale("unknown", 2.0, 30), 2.0, "unknown projection");
});

// ---- tileAngleFromCenter ----

test("tileAngleFromCenter: 中心タイルは角距離0", function() {
   var angle = tileAngleFromCenter(500, 500, 500, 500, 2.0);
   assertEqual(angle, 0, "center tile", 0.0001);
});

test("tileAngleFromCenter: 既知の距離", function() {
   // 1000px離れていて、スケール3.6 arcsec/px → 3600 arcsec = 1°
   var angle = tileAngleFromCenter(1500, 500, 500, 500, 3.6);
   assertEqual(angle, 1.0, "1000px at 3.6 arcsec/px", 0.001);
});

test("tileAngleFromCenter: 対角方向", function() {
   // dx=300, dy=400 → dist=500px, 2.0 arcsec/px → 1000 arcsec ≈ 0.2778°
   var angle = tileAngleFromCenter(800, 900, 500, 500, 2.0);
   assertEqual(angle, 500 * 2.0 / 3600.0, "diagonal", 0.0001);
});

// ---- computePixelScale ----

test("computePixelScale: ASI2600MC + 250mm (RedCat 51)", function() {
   // 206.265 * 3.76 / 250 = 3.102 arcsec/px
   var scale = computePixelScale(3.76, 250);
   assertEqual(scale, 3.102, "ASI2600 + RedCat", 0.01);
});

test("computePixelScale: Canon 6D + 35mm レンズ", function() {
   // 206.265 * 6.55 / 35 = 38.6 arcsec/px
   var scale = computePixelScale(6.55, 35);
   assertEqual(scale, 38.6, "Canon 6D + 35mm", 0.1);
});

test("computePixelScale: ゼロ入力 → 0", function() {
   assertEqual(computePixelScale(0, 250), 0, "zero pitch");
   assertEqual(computePixelScale(3.76, 0), 0, "zero focal");
});

// ---- computeDiagonalFov ----

test("computeDiagonalFov: ASI2600MC + 250mm", function() {
   // diag = sqrt(6248² + 4176²) = 7514.9px, scale = 3.102 arcsec/px
   // FOV = 7514.9 * 3.102 / 3600 = 6.47°
   var fov = computeDiagonalFov(6248, 4176, 3.102);
   assertEqual(fov, 6.47, "ASI2600 + 250mm", 0.1);
});

test("computeDiagonalFov: ゼロスケール → 0", function() {
   assertEqual(computeDiagonalFov(6248, 4176, 0), 0, "zero scale");
});

// ---- recommendGrid ----

test("recommendGrid: 5° → 1x1 (単一ソルブ)", function() {
   var r = recommendGrid(5, 6248, 4176);
   assertEqual(r.cols, 1, "cols");
   assertEqual(r.rows, 1, "rows");
});

test("recommendGrid: 15° → 2x2", function() {
   var r = recommendGrid(15, 6248, 4176);
   assertEqual(r.cols, 2, "cols");
   assertEqual(r.rows, 2, "rows");
});

test("recommendGrid: 35° → 3x2", function() {
   var r = recommendGrid(35, 6248, 4176);
   assertEqual(r.cols, 3, "cols");
   assertEqual(r.rows, 2, "rows");
});

test("recommendGrid: 55° → 4x3", function() {
   var r = recommendGrid(55, 6248, 4176);
   assertEqual(r.cols, 4, "cols");
   assertEqual(r.rows, 3, "rows");
});

test("recommendGrid: 85° → 6x4", function() {
   var r = recommendGrid(85, 6248, 4176);
   assertEqual(r.cols, 6, "cols");
   assertEqual(r.rows, 4, "rows");
});

test("recommendGrid: 150° → 12x8 (全天)", function() {
   var r = recommendGrid(150, 6248, 4176);
   assertEqual(r.cols, 12, "cols");
   assertEqual(r.rows, 8, "rows");
});

test("recommendGrid: FOV不明 → 1x1", function() {
   var r = recommendGrid(0, 6248, 4176);
   assertEqual(r.cols, 1, "cols");
   assertEqual(r.rows, 1, "rows");
});

// ---- findGridPresetIndex ----

test("findGridPresetIndex: 一致あり", function() {
   var presets = [[1,1], [2,2], [3,3], [4,3]];
   assertEqual(findGridPresetIndex(presets, 3, 3), 2, "3x3 found");
});

test("findGridPresetIndex: 一致なし → -1", function() {
   var presets = [[1,1], [2,2], [3,3]];
   assertEqual(findGridPresetIndex(presets, 5, 5), -1, "5x5 not found");
});

// ---- convertToWcsResult ----

test("convertToWcsResult: SIP なしの場合", function() {
   var wcs = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   var result = convertToWcsResult(wcs, 6248, 4176);
   assertEqual(result.crval1, 180.0, "crval1");
   assertEqual(result.crval2, 45.0, "crval2");
   assertEqual(result.cd[0][0], -0.001, "cd11");
   assertEqual(result.sip, null, "no sip");
   assertEqual(result.sipMode, null, "no sipMode");
});

test("convertToWcsResult: SIP ありの場合", function() {
   var wcs = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001,
      aOrder: 2,
      sipCoeffs: { a: [[0, 0, 1e-7], [0, 1e-7]], b: [[0, 0], [0, 0, 1e-7]] }
   };
   var result = convertToWcsResult(wcs, 6248, 4176);
   assertEqual(result.sip.order, 2, "sip order");
   assertEqual(result.sipMode, "approx", "sipMode");
   assertTrue(result.sip.a.length > 0, "sip.a exists");
});

// ---- pixelToRaDec ----

test("pixelToRaDec: CRPIX位置 → CRVAL", function() {
   // CRPIX は FITS 座標系（1-based, y反転）
   // px=3123 (0-based), imageHeight=4176
   // u = (3123 + 1) - 3124 = 0
   // v = (4176 - 3123) - 1053 = 0 ... CRPIX2=1053 の場合
   // → CRVAL を返すはず
   var wcs = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 1053,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001,
      sip: null
   };
   var imageHeight = 4176;
   var px = 3123;  // 0-based: CRPIX1-1
   var py = 3123;  // 0-based: imageHeight - CRPIX2
   var result = pixelToRaDec(wcs, px, py, imageHeight);
   assertEqual(result[0], 180.0, "RA at CRPIX", 0.0001);
   assertEqual(result[1], 45.0, "DEC at CRPIX", 0.0001);
});

test("pixelToRaDec: CRPIX からのオフセット", function() {
   var wcs = {
      crval1: 180.0, crval2: 0.0,
      crpix1: 501, crpix2: 501,
      cd1_1: -1.0/3600, cd1_2: 0, cd2_1: 0, cd2_2: 1.0/3600,
      sip: null
   };
   var imageHeight = 1000;
   // px=500 (0-based), py=499 → CRPIX position
   // px=600 → u = 601-501 = 100, scale 1 arcsec/px → 100 arcsec offset in RA
   var result = pixelToRaDec(wcs, 600, 499, imageHeight);
   // RA should decrease (CD1_1 is negative) by ~100 arcsec ≈ 0.0278°
   assertTrue(result[0] < 180.0, "RA shifted: " + result[0]);
   var raDiff = Math.abs(result[0] - 180.0) * 3600; // arcsec
   assertEqual(raDiff, 100, "RA offset ~100 arcsec", 1);
});

// ---- validateOverlap ----

test("validateOverlap: 整合性の高い2タイル → 無効化なし", function() {
   // 同じ WCS を持つ隣接タイル（完全一致するはず）
   var wcsData = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   var tiles = [
      { col: 0, row: 0, offsetX: 0, offsetY: 0, tileWidth: 3500, tileHeight: 4176, status: "success", wcs: wcsData },
      { col: 1, row: 0, offsetX: 3000, offsetY: 0, tileWidth: 3248, tileHeight: 4176, status: "success", wcs: wcsData }
   ];
   var result = validateOverlap(tiles, 6248, 4176);
   assertEqual(result, 0, "no tiles invalidated");
});

test("validateOverlap: WCS が大きくずれたタイル → 無効化", function() {
   var wcs1 = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   // 2つ目のタイルは CRVAL を大きくずらす → 重複領域で不一致
   var wcs2 = {
      crval1: 185.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   var tiles = [
      { col: 0, row: 0, offsetX: 0, offsetY: 0, tileWidth: 3500, tileHeight: 4176, status: "success", wcs: wcs1 },
      { col: 1, row: 0, offsetX: 3000, offsetY: 0, tileWidth: 3248, tileHeight: 4176, status: "success", wcs: wcs2 }
   ];
   var result = validateOverlap(tiles, 6248, 4176, 5.0);
   assertTrue(result >= 1, "at least 1 tile invalidated: " + result);
});

test("validateOverlap: オーバーラップなしのタイル → 無効化なし", function() {
   var wcs1 = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   var tiles = [
      { col: 0, row: 0, offsetX: 0, offsetY: 0, tileWidth: 3000, tileHeight: 4176, status: "success", wcs: wcs1 },
      { col: 1, row: 0, offsetX: 3248, offsetY: 0, tileWidth: 3000, tileHeight: 4176, status: "success", wcs: wcs1 }
   ];
   var result = validateOverlap(tiles, 6248, 4176);
   assertEqual(result, 0, "no overlap = no validation");
});

test("validateOverlap: 失敗タイルは無視される", function() {
   var wcsData = {
      crval1: 180.0, crval2: 45.0,
      crpix1: 3124, crpix2: 2088,
      cd1_1: -0.001, cd1_2: 0, cd2_1: 0, cd2_2: 0.001
   };
   var tiles = [
      { col: 0, row: 0, offsetX: 0, offsetY: 0, tileWidth: 3500, tileHeight: 4176, status: "success", wcs: wcsData },
      { col: 1, row: 0, offsetX: 3000, offsetY: 0, tileWidth: 3248, tileHeight: 4176, status: "failed", wcs: null }
   ];
   var result = validateOverlap(tiles, 6248, 4176);
   assertEqual(result, 0, "only 1 success tile = skip validation");
});

// ---- 機材 DB 計算の結合テスト（実際のカメラ/レンズの組み合わせ） ----

test("機材計算: ASI2600MC Pro + RedCat 51 → スケール・FOV・グリッド", function() {
   var scale = computePixelScale(3.76, 250);  // 3.10 arcsec/px
   var fov = computeDiagonalFov(6248, 4176, scale);  // ~6.5°
   var grid = recommendGrid(fov, 6248, 4176);
   assertTrue(scale > 3.0 && scale < 3.2, "scale ~3.1: " + scale);
   assertTrue(fov > 6 && fov < 7, "FOV ~6.5°: " + fov);
   assertEqual(grid.cols, 1, "1x1 for narrow FOV");
   assertEqual(grid.rows, 1, "1x1 rows");
});

test("機材計算: Canon 6D + 35mm → スケール・FOV・グリッド", function() {
   var scale = computePixelScale(6.55, 35);  // 38.6 arcsec/px
   var fov = computeDiagonalFov(5472, 3648, scale);  // ~63° (arctan-based)
   var grid = recommendGrid(fov, 5472, 3648);
   assertTrue(scale > 38 && scale < 39, "scale ~38.6: " + scale);
   assertTrue(fov > 60 && fov < 66, "FOV ~63°: " + fov);
   assertEqual(grid.cols, 6, "6x4 for ~63° FOV");
   assertEqual(grid.rows, 4, "6x4 rows");
});

test("機材計算: ASI585MC + 8mm Fisheye → 超広角", function() {
   var scale = computePixelScale(2.90, 8);  // 74.8 arcsec/px
   var fov = computeDiagonalFov(3840, 2160, scale);  // ~77° (arctan-based)
   var grid = recommendGrid(fov, 3840, 2160);
   assertTrue(fov > 74 && fov < 80, "FOV ~77°: " + fov);
   // 60° < fov < 90° → 6x4
   assertEqual(grid.cols, 6, "6x4 for wide angle");
   assertEqual(grid.rows, 4, "6x4 rows");
});

//============================================================================
// 結果サマリー
//============================================================================

console.log("");
console.log("==============================");
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("==============================");

if (failed > 0) {
   process.exit(1);
}
