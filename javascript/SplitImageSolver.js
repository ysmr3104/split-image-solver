#feature-id    SplitImageSolver : Utilities > SplitImageSolver
#feature-info  Automatic plate solver using astrometry.net API: single-image or \
   split-tile solve with WCS application for PixInsight.

//----------------------------------------------------------------------------
// SplitImageSolver.js - PixInsight JavaScript Runtime (PJSR) Script
//
// Automatic plate solver using astrometry.net API.
// Single-image solve with WCS application.
//
// Copyright (c) 2026 Split Image Solver Project
//----------------------------------------------------------------------------

#define VERSION "0.2.0"

#include <pjsr/DataType.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/Color.jsh>
#include <pjsr/PropertyType.jsh>
#include <pjsr/PropertyAttribute.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/ImageOp.jsh>

#include "wcs_math.js"
#include "wcs_keywords.js"
#include "astrometry_api.js"
#include "equipment_data.jsh"

#define TITLE "Split Image Solver"

// Equipment data is loaded via #include "equipment_data.jsh" (sets __equipmentData__)

//============================================================================
// Ported utility functions from ManualImageSolver.js
//============================================================================

// Convert RA (degrees) to "HH MM SS.ss" format
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

// Convert DEC (degrees) to "+DD MM SS.s" format
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

// Parse RA input (HMS "HH MM SS.ss" / "HH:MM:SS.ss" or degrees)
// On success: degrees (0-360), on failure: null
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

// Parse DEC input (DMS "+/-DD MM SS.ss" / "+/-DD:MM:SS.ss" or degrees)
// On success: degrees (-90 to +90), on failure: null
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

// Convert pixel coordinates to celestial coordinates (using WCS parameters)
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

// Display coordinates of image corners and center to the console
function displayImageCoordinates(wcs, imageWidth, imageHeight) {
   var center = pixelToRaDec(wcs, imageWidth / 2.0, imageHeight / 2.0, imageHeight);
   var tl = pixelToRaDec(wcs, 0, 0, imageHeight);
   var tr = pixelToRaDec(wcs, imageWidth - 1, 0, imageHeight);
   var bl = pixelToRaDec(wcs, 0, imageHeight - 1, imageHeight);
   var br = pixelToRaDec(wcs, imageWidth - 1, imageHeight - 1, imageHeight);

   console.writeln("");
   console.writeln("<b>Image coordinates:</b>");
   console.writeln("  Center ........ RA: " + raToHMS(center[0]) + "  Dec: " + decToDMS(center[1]));
   console.writeln("  Top-Left ...... RA: " + raToHMS(tl[0]) + "  Dec: " + decToDMS(tl[1]));
   console.writeln("  Top-Right ..... RA: " + raToHMS(tr[0]) + "  Dec: " + decToDMS(tr[1]));
   console.writeln("  Bottom-Left ... RA: " + raToHMS(bl[0]) + "  Dec: " + decToDMS(bl[1]));
   console.writeln("  Bottom-Right .. RA: " + raToHMS(br[0]) + "  Dec: " + decToDMS(br[1]));

   var widthFov = angularSeparation(tl, tr);
   var heightFov = angularSeparation(tl, bl);
   console.writeln("  Field of view . " + widthFov.toFixed(2) + " x " + heightFov.toFixed(2) + " deg");

   var rotationDeg = Math.atan2(-wcs.cd1_2, wcs.cd2_2) * 180.0 / Math.PI;
   console.writeln("  Rotation ...... " + rotationDeg.toFixed(2) + " deg");
}

// Sesame object name search (ExternalProcess + curl)
function searchObjectCoordinates(objectName) {
   var encoded = objectName.replace(/ /g, "+");
   var url = "http://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-oI/A?" + encoded;
   var tmpFile = File.systemTempDirectory + "/sesame_query.txt";

   var P = new ExternalProcess;
   P.start("curl", ["-s", "-o", tmpFile, "-m", "10", url]);
   if (!P.waitForFinished(15000)) {
      P.kill();
      return null;
   }
   if (P.exitCode !== 0) return null;
   if (!File.exists(tmpFile)) return null;

   var content = "";
   try {
      content = File.readTextFile(tmpFile);
      File.remove(tmpFile);
   } catch (e) {
      return null;
   }

   var lines = content.split("\n");
   for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("%J") === 0) {
         var coords = line.substring(2).trim();
         var eqIdx = coords.indexOf("=");
         if (eqIdx > 0) coords = coords.substring(0, eqIdx).trim();
         var parts = coords.split(/\s+/);
         if (parts.length >= 2) {
            var ra = parseFloat(parts[0]);
            var dec = parseFloat(parts[1]);
            if (!isNaN(ra) && !isNaN(dec)) return { ra: ra, dec: dec };
         }
      }
   }
   return null;
}

//============================================================================
// WCS application function
//============================================================================

function applyWCSToImage(targetWindow, wcsResult, imageWidth, imageHeight) {
   var existingKw = targetWindow.keywords;
   var cleanedKw = [];
   for (var i = 0; i < existingKw.length; i++) {
      if (!isWCSKeyword(existingKw[i].name))
         cleanedKw.push(existingKw[i]);
   }

   var hasSip = wcsResult.sip && wcsResult.sip.order > 0;
   cleanedKw.push(makeFITSKeyword("CTYPE1", hasSip ? "RA---TAN-SIP" : "RA---TAN"));
   cleanedKw.push(makeFITSKeyword("CTYPE2", hasSip ? "DEC--TAN-SIP" : "DEC--TAN"));
   cleanedKw.push(makeFITSKeyword("CRVAL1", wcsResult.crval1));
   cleanedKw.push(makeFITSKeyword("CRVAL2", wcsResult.crval2));
   cleanedKw.push(makeFITSKeyword("CRPIX1", wcsResult.crpix1));
   cleanedKw.push(makeFITSKeyword("CRPIX2", wcsResult.crpix2));
   cleanedKw.push(makeFITSKeyword("CD1_1", wcsResult.cd[0][0]));
   cleanedKw.push(makeFITSKeyword("CD1_2", wcsResult.cd[0][1]));
   cleanedKw.push(makeFITSKeyword("CD2_1", wcsResult.cd[1][0]));
   cleanedKw.push(makeFITSKeyword("CD2_2", wcsResult.cd[1][1]));
   cleanedKw.push(makeFITSKeyword("CUNIT1", "deg"));
   cleanedKw.push(makeFITSKeyword("CUNIT2", "deg"));
   cleanedKw.push(makeFITSKeyword("RADESYS", "ICRS"));
   cleanedKw.push(makeFITSKeyword("EQUINOX", 2000.0));
   cleanedKw.push(makeFITSKeyword("PLTSOLVD", "T"));

   if (hasSip) {
      var sip = wcsResult.sip;
      cleanedKw.push(makeFITSKeyword("A_ORDER", sip.order));
      cleanedKw.push(makeFITSKeyword("B_ORDER", sip.order));
      for (var i = 0; i < sip.a.length; i++) {
         cleanedKw.push(makeFITSKeyword("A_" + sip.a[i][0] + "_" + sip.a[i][1], sip.a[i][2]));
      }
      for (var i = 0; i < sip.b.length; i++) {
         cleanedKw.push(makeFITSKeyword("B_" + sip.b[i][0] + "_" + sip.b[i][1], sip.b[i][2]));
      }
      if (sip.ap && sip.bp) {
         var apOrder = sip.invOrder || sip.order;
         cleanedKw.push(makeFITSKeyword("AP_ORDER", apOrder));
         cleanedKw.push(makeFITSKeyword("BP_ORDER", apOrder));
         for (var i = 0; i < sip.ap.length; i++) {
            cleanedKw.push(makeFITSKeyword("AP_" + sip.ap[i][0] + "_" + sip.ap[i][1], sip.ap[i][2]));
         }
         for (var i = 0; i < sip.bp.length; i++) {
            cleanedKw.push(makeFITSKeyword("BP_" + sip.bp[i][0] + "_" + sip.bp[i][1], sip.bp[i][2]));
         }
      }
   }

   // Write image center RA/DEC as OBJCTRA/OBJCTDEC
   var wcsObj = {
      crval1: wcsResult.crval1, crval2: wcsResult.crval2,
      crpix1: wcsResult.crpix1, crpix2: wcsResult.crpix2,
      cd1_1: wcsResult.cd[0][0], cd1_2: wcsResult.cd[0][1],
      cd2_1: wcsResult.cd[1][0], cd2_2: wcsResult.cd[1][1],
      sip: wcsResult.sip
   };
   var imgCenter = pixelToRaDec(wcsObj, imageWidth / 2.0, imageHeight / 2.0, imageHeight);
   cleanedKw.push(makeFITSKeyword("OBJCTRA", raToHMS(imgCenter[0])));
   cleanedKw.push(makeFITSKeyword("OBJCTDEC", decToDMS(imgCenter[1])));

   targetWindow.keywords = cleanedKw;
   targetWindow.regenerateAstrometricSolution();
}

//----------------------------------------------------------------------------
// Control point setup (all modes)
//----------------------------------------------------------------------------
function setCustomControlPoints(window, wcsResult, starPairs, imageWidth, imageHeight, gridMode) {
   if (!gridMode) gridMode = "off";

   var view = window.mainView;
   var crval = [wcsResult.crval1, wcsResult.crval2];
   var cd = wcsResult.cd;
   var crpix1 = wcsResult.crpix1;
   var crpix2 = wcsResult.crpix2;
   var DEG2RAD = Math.PI / 180.0;

   var isInterp = wcsResult.sipMode === "interp";
   var hasSipCoeffs = wcsResult.sip && wcsResult.sip.a && wcsResult.sip.b;

   // Pre-compute star 3D residuals for "smooth" mode (IDW interpolation)
   var starResiduals = null;
   if (gridMode === "smooth" && starPairs.length >= 3) {
      starResiduals = [];
      for (var i = 0; i < starPairs.length; i++) {
         var u = (starPairs[i].px + 1) - crpix1;
         var v = (imageHeight - starPairs[i].py) - crpix2;
         var xiLin = cd[0][0] * u + cd[0][1] * v;
         var etaLin = cd[1][0] * u + cd[1][1] * v;
         var approx = tanDeproject(crval, [xiLin, etaLin]);
         if (!approx) continue;
         var raA = approx[0] * DEG2RAD, decA = approx[1] * DEG2RAD;
         var xLin = Math.cos(decA) * Math.cos(raA);
         var yLin = Math.cos(decA) * Math.sin(raA);
         var zLin = Math.sin(decA);
         var raE = starPairs[i].ra * DEG2RAD, decE = starPairs[i].dec * DEG2RAD;
         var xEx = Math.cos(decE) * Math.cos(raE);
         var yEx = Math.cos(decE) * Math.sin(raE);
         var zEx = Math.sin(decE);
         starResiduals.push({
            u: u, v: v,
            dx: xEx - xLin, dy: yEx - yLin, dz: zEx - zLin
         });
      }
      if (starResiduals.length < 3) starResiduals = null;
   }

   // IDW sigma: average nearest-neighbor distance among stars
   var sigma2 = 0;
   if (starResiduals) {
      var totalNN = 0;
      for (var i = 0; i < starResiduals.length; i++) {
         var minD2 = Infinity;
         for (var j = 0; j < starResiduals.length; j++) {
            if (i === j) continue;
            var du = starResiduals[i].u - starResiduals[j].u;
            var dv = starResiduals[i].v - starResiduals[j].v;
            var d2 = du * du + dv * dv;
            if (d2 < minD2) minD2 = d2;
         }
         totalNN += Math.sqrt(minD2);
      }
      var avgNN = totalNN / starResiduals.length;
      sigma2 = avgNN * avgNN;
   }

   // Compute gnomonic coords for a pixel using IDW-corrected 3D vectors + tanProject
   function smoothGnomonic(u, v) {
      var xiLin = cd[0][0] * u + cd[0][1] * v;
      var etaLin = cd[1][0] * u + cd[1][1] * v;
      var approx = tanDeproject(crval, [xiLin, etaLin]);
      if (!approx) return { xi: xiLin, eta: etaLin };
      var raA = approx[0] * DEG2RAD, decA = approx[1] * DEG2RAD;
      var xBase = Math.cos(decA) * Math.cos(raA);
      var yBase = Math.cos(decA) * Math.sin(raA);
      var zBase = Math.sin(decA);
      var wSum = 0, wdx = 0, wdy = 0, wdz = 0;
      for (var i = 0; i < starResiduals.length; i++) {
         var du = u - starResiduals[i].u;
         var dv = v - starResiduals[i].v;
         var w = Math.exp(-(du * du + dv * dv) / (2 * sigma2));
         wSum += w;
         wdx += w * starResiduals[i].dx;
         wdy += w * starResiduals[i].dy;
         wdz += w * starResiduals[i].dz;
      }
      if (wSum > 1e-15) {
         xBase += wdx / wSum;
         yBase += wdy / wSum;
         zBase += wdz / wSum;
      }
      var r = Math.sqrt(xBase * xBase + yBase * yBase + zBase * zBase);
      if (r < 1e-15) return { xi: xiLin, eta: etaLin };
      xBase /= r; yBase /= r; zBase /= r;
      var dec = Math.asin(Math.max(-1, Math.min(1, zBase)));
      var ra = Math.atan2(yBase, xBase);
      if (ra < 0) ra += 2 * Math.PI;
      var proj = tanProject(crval, [ra / DEG2RAD, dec / DEG2RAD]);
      return proj ? { xi: proj[0], eta: proj[1] } : { xi: xiLin, eta: etaLin };
   }

   // 1. Grid control points
   var STAR_EXCLUSION_RADIUS = 100;
   function cdToGnomonic(u, v) {
      var uCorr = u, vCorr = v;
      if (!isInterp && hasSipCoeffs) {
         uCorr = u + evalSipPolynomial(wcsResult.sip.a, u, v);
         vCorr = v + evalSipPolynomial(wcsResult.sip.b, u, v);
      }
      return {
         xi: cd[0][0] * uCorr + cd[0][1] * vCorr,
         eta: cd[1][0] * uCorr + cd[1][1] * vCorr
      };
   }

   var effectiveMode = isInterp ? gridMode : "off";
   var nGridX = (effectiveMode === "linear") ? 4 : 20;
   var nGridY = (effectiveMode === "linear") ? 4 : 30;
   var gridPoints = [];
   for (var gy = 0; gy <= nGridY; gy++) {
      for (var gx = 0; gx <= nGridX; gx++) {
         var px = gx * (imageWidth - 1) / nGridX;
         var py = gy * (imageHeight - 1) / nGridY;
         var u = (px + 1) - crpix1;
         var v = (imageHeight - py) - crpix2;
         if (effectiveMode === "off") {
            var tooClose = false;
            for (var s = 0; s < starPairs.length; s++) {
               var dx = px - starPairs[s].px;
               var dy = py - starPairs[s].py;
               if (dx * dx + dy * dy < STAR_EXCLUSION_RADIUS * STAR_EXCLUSION_RADIUS) {
                  tooClose = true;
                  break;
               }
            }
            if (tooClose) continue;
         }
         if (effectiveMode === "smooth" && starResiduals) {
            var g = smoothGnomonic(u, v);
            gridPoints.push({ px: px, py: py, xi: g.xi, eta: g.eta });
         } else {
            var g = cdToGnomonic(u, v);
            gridPoints.push({ px: px, py: py, xi: g.xi, eta: g.eta });
         }
      }
   }

   // 2. Star control points
   var starPoints = [];
   for (var i = 0; i < starPairs.length; i++) {
      var u = (starPairs[i].px + 1) - crpix1;
      var v = (imageHeight - starPairs[i].py) - crpix2;
      if (effectiveMode === "smooth" && starResiduals) {
         var g = smoothGnomonic(u, v);
         starPoints.push({ px: starPairs[i].px, py: starPairs[i].py, xi: g.xi, eta: g.eta });
      } else if (effectiveMode === "linear") {
         var g = cdToGnomonic(u, v);
         starPoints.push({ px: starPairs[i].px, py: starPairs[i].py, xi: g.xi, eta: g.eta });
      } else {
         var proj = tanProject(crval, [starPairs[i].ra, starPairs[i].dec]);
         if (proj) {
            starPoints.push({
               px: starPairs[i].px, py: starPairs[i].py,
               xi: proj[0], eta: proj[1]
            });
         }
      }
   }

   // 3. Convert to Vectors (cI: Image coords, cW: World coords)
   var nTotal = gridPoints.length + starPoints.length;
   var cI = new Vector(nTotal * 2);
   var cW = new Vector(nTotal * 2);

   for (var i = 0; i < gridPoints.length; i++) {
      cI.at(i * 2,     gridPoints[i].px);
      cI.at(i * 2 + 1, gridPoints[i].py);
      cW.at(i * 2,     gridPoints[i].xi);
      cW.at(i * 2 + 1, gridPoints[i].eta);
   }

   var off = gridPoints.length;
   for (var i = 0; i < starPoints.length; i++) {
      cI.at((off + i) * 2,     starPoints[i].px);
      cI.at((off + i) * 2 + 1, starPoints[i].py);
      cW.at((off + i) * 2,     starPoints[i].xi);
      cW.at((off + i) * 2 + 1, starPoints[i].eta);
   }

   // 4. Write to image properties (full spline config overwrite)
   var attrs = PropertyAttribute_Storable | PropertyAttribute_Permanent;
   var prefix = "PCL:AstrometricSolution:SplineWorldTransformation:";
   view.setPropertyValue(prefix + "RBFType", "ThinPlateSpline", PropertyType_String8, attrs);
   view.setPropertyValue(prefix + "SplineOrder", 2, PropertyType_Int32, attrs);
   view.setPropertyValue(prefix + "SplineSmoothness", 0, PropertyType_Float32, attrs);
   view.setPropertyValue(prefix + "MaxSplinePoints", nTotal, PropertyType_Int32, attrs);
   view.setPropertyValue(prefix + "UseSimplifiers", false, PropertyType_Boolean, attrs);
   view.setPropertyValue(prefix + "SimplifierRejectFraction", 0.10, PropertyType_Float32, attrs);
   view.setPropertyValue(prefix + "ControlPoints:Image", cI, PropertyType_F64Vector, attrs);
   view.setPropertyValue(prefix + "ControlPoints:World", cW, PropertyType_F64Vector, attrs);

   var modeLabel = gridMode === "smooth" ? " (smooth)" : gridMode === "linear" ? " (linear)" : "";
   console.writeln("  Control points overwritten: grid " + gridPoints.length + " + stars " + starPoints.length + " = " + nTotal + " points" + modeLabel);
}

//============================================================================
// WCS FITS header parsing
//============================================================================

// Read WCS parameters from a FITS file (header-only supported)
// Uses FileFormatInstance to read FITS keywords without requiring image data.
function readWcsFromFits(fitsPath) {
   // astrometry.net WCS files are header-only FITS (no image data).
   // PixInsight's FileFormatInstance refuses to open them.
   // Parse the FITS header directly as 80-byte fixed-width records.
   var raw;
   try {
      raw = File.readTextFile(fitsPath);
   } catch (e) {
      console.writeln("readWcsFromFits: cannot read " + fitsPath + ": " + e.message);
      return null;
   }
   if (!raw || raw.length < 80) {
      console.writeln("readWcsFromFits: file too small or empty: " + fitsPath);
      return null;
   }

   var wcs = {};
   // FITS header: 80-char fixed-width cards until END
   for (var pos = 0; pos + 80 <= raw.length; pos += 80) {
      var card = raw.substring(pos, pos + 80);
      var keyword = card.substring(0, 8).replace(/ +$/, "");
      if (keyword === "END") break;
      if (card.charAt(8) !== "=" || card.charAt(9) !== " ") continue;

      // Value field starts at column 10, may have / comment
      var valStr = card.substring(10);
      var slashIdx = valStr.indexOf("/");
      if (slashIdx >= 0) valStr = valStr.substring(0, slashIdx);
      valStr = valStr.trim();
      // Remove quotes for string values
      valStr = valStr.replace(/^'|'$/g, "").trim();

      switch (keyword) {
         case "CRVAL1": wcs.crval1 = parseFloat(valStr); break;
         case "CRVAL2": wcs.crval2 = parseFloat(valStr); break;
         case "CRPIX1": wcs.crpix1 = parseFloat(valStr); break;
         case "CRPIX2": wcs.crpix2 = parseFloat(valStr); break;
         case "CD1_1": wcs.cd1_1 = parseFloat(valStr); break;
         case "CD1_2": wcs.cd1_2 = parseFloat(valStr); break;
         case "CD2_1": wcs.cd2_1 = parseFloat(valStr); break;
         case "CD2_2": wcs.cd2_2 = parseFloat(valStr); break;
         case "A_ORDER": wcs.aOrder = parseInt(valStr); break;
         case "B_ORDER": wcs.bOrder = parseInt(valStr); break;
         case "AP_ORDER": wcs.apOrder = parseInt(valStr); break;
         case "BP_ORDER": wcs.bpOrder = parseInt(valStr); break;
      }
      // SIP coefficients: A_i_j, B_i_j, AP_i_j, BP_i_j
      var sipMatch = keyword.match(/^(A|B|AP|BP)_(\d+)_(\d+)$/);
      if (sipMatch) {
         var sipPrefix = sipMatch[1].toLowerCase();
         if (!wcs.sipCoeffs) wcs.sipCoeffs = {};
         if (!wcs.sipCoeffs[sipPrefix]) wcs.sipCoeffs[sipPrefix] = [];
         wcs.sipCoeffs[sipPrefix].push([parseInt(sipMatch[2]), parseInt(sipMatch[3]), parseFloat(valStr)]);
      }
   }

   if (wcs.crval1 === undefined || wcs.crval2 === undefined) {
      console.writeln("readWcsFromFits: no WCS keywords found in " + fitsPath);
      return null;
   }

   return wcs;
}

// Convert readWcsFromFits result to WCSFitter-compatible wcsResult format
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

   // SIP coefficients conversion
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
// Phase 2: Tile splitting, multi-tile solve, and WCS merging
//============================================================================

//----------------------------------------------------------------------------
// splitImageToTiles
//
// Split an image into a grid of overlapping tiles and save as temporary FITS.
//
// targetWindow: ImageWindow to split
// gridX, gridY: number of columns and rows
// overlap: overlap in pixels
//
// Returns array of tile objects:
//   { filePath, col, row, offsetX, offsetY, tileWidth, tileHeight,
//     scaleFactor, origOffsetX, origOffsetY, origTileWidth, origTileHeight }
//----------------------------------------------------------------------------
function splitImageToTiles(targetWindow, gridX, gridY, overlap) {
   var image = targetWindow.mainView.image;
   var imgW = image.width;
   var imgH = image.height;

   // Compute tile sizes (before overlap)
   var baseTileW = Math.floor(imgW / gridX);
   var baseTileH = Math.floor(imgH / gridY);

   var tiles = [];
   var tmpDir = File.systemTempDirectory;

   for (var row = 0; row < gridY; row++) {
      for (var col = 0; col < gridX; col++) {
         // Tile region with overlap
         var x0 = col * baseTileW - overlap;
         var y0 = row * baseTileH - overlap;
         var x1 = (col + 1 === gridX) ? imgW : (col + 1) * baseTileW + overlap;
         var y1 = (row + 1 === gridY) ? imgH : (row + 1) * baseTileH + overlap;

         // Clamp to image boundaries
         if (x0 < 0) x0 = 0;
         if (y0 < 0) y0 = 0;
         if (x1 > imgW) x1 = imgW;
         if (y1 > imgH) y1 = imgH;

         var tileW = x1 - x0;
         var tileH = y1 - y0;
         if (tileW < 10 || tileH < 10) continue;

         // Create a new ImageWindow for the tile
         var tileWin = new ImageWindow(tileW, tileH,
            image.numberOfChannels, image.bitsPerSample,
            image.sampleType === SampleType_Real, image.isColor,
            "tile_" + col + "_" + row);

         // Copy pixel data from source using selectedRect
         tileWin.mainView.beginProcess(UndoFlag_NoSwapFile);
         image.selectedRect = new Rect(x0, y0, x1, y1);
         tileWin.mainView.image.apply(image, ImageOp_Mov);
         image.resetSelections();
         tileWin.mainView.endProcess();

         // Downsample if tile is too large (long edge > 2000px)
         var scaleFactor = 1.0;
         var maxEdge = Math.max(tileW, tileH);
         if (maxEdge > 2000) {
            scaleFactor = 2000.0 / maxEdge;
            var newW = Math.round(tileW * scaleFactor);
            var newH = Math.round(tileH * scaleFactor);

            var resample = new Resample;
            resample.mode = Resample.prototype.AbsolutePixels;
            resample.absoluteMode = Resample.prototype.ForceWidthAndHeight;
            resample.xSize = newW;
            resample.ySize = newH;
            resample.interpolation = Resample.prototype.Auto;
            resample.executeOn(tileWin.mainView);
         }

         // Save to FITS using FileFormatInstance
         var fitsPath = tmpDir + "/split_tile_" + col + "_" + row + ".fits";
         var fmt = new FileFormat("FITS");
         var wrt = new FileFormatInstance(fmt);
         if (wrt.create(fitsPath)) {
            wrt.writeImage(tileWin.mainView.image);
            wrt.close();
         }

         tileWin.forceClose();

         tiles.push({
            filePath: fitsPath,
            col: col,
            row: row,
            offsetX: x0,
            offsetY: y0,
            tileWidth: tileW,
            tileHeight: tileH,
            scaleFactor: scaleFactor,
            // For CRPIX reverse transform
            origOffsetX: x0,
            origOffsetY: y0,
            origTileWidth: tileW,
            origTileHeight: tileH,
            // Solve result (filled later)
            wcs: null,
            status: "pending"  // pending, solving, success, failed
         });
      }
   }

   console.writeln("Split image into " + tiles.length + " tiles (" + gridX + "x" + gridY + ")");

   // Sort tiles: upper half first (by distance from center), then lower half
   // For odd gridY, the middle row belongs to the upper half
   var centerCol = (gridX - 1) / 2.0;
   var centerRow = (gridY - 1) / 2.0;
   var upperRowLimit = Math.ceil(gridY / 2.0); // e.g., gridY=3 -> rows 0,1 are upper; gridY=4 -> rows 0,1
   tiles.sort(function(a, b) {
      var aUpper = (a.row < upperRowLimit) ? 0 : 1;
      var bUpper = (b.row < upperRowLimit) ? 0 : 1;
      if (aUpper !== bUpper) return aUpper - bUpper;
      // Within same half: sort by distance from image center
      var da = (a.col - centerCol) * (a.col - centerCol) + (a.row - centerRow) * (a.row - centerRow);
      var db = (b.col - centerCol) * (b.col - centerCol) + (b.row - centerRow) * (b.row - centerRow);
      if (da !== db) return da - db;
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
   });

   var orderLog = "Tile order: ";
   for (var si = 0; si < tiles.length; si++) {
      orderLog += "[" + tiles[si].col + "," + tiles[si].row + "]";
      if (si < tiles.length - 1) orderLog += " -> ";
   }
   console.writeln(orderLog);

   return tiles;
}

//----------------------------------------------------------------------------
// formatElapsed - format milliseconds as M:SS
//----------------------------------------------------------------------------
function formatElapsed(ms) {
   var totalSec = Math.floor(ms / 1000);
   var min = Math.floor(totalSec / 60);
   var sec = totalSec % 60;
   return min + ":" + (sec < 10 ? "0" : "") + sec;
}

// Format current local time as HH:MM:SS
function timestamp() {
   var d = new Date();
   var h = d.getHours();
   var m = d.getMinutes();
   var s = d.getSeconds();
   return (h < 10 ? "0" : "") + h + ":" +
          (m < 10 ? "0" : "") + m + ":" +
          (s < 10 ? "0" : "") + s;
}

//----------------------------------------------------------------------------
// solveMultipleTiles
//
// Solve multiple tiles using astrometry.net API sequentially.
//
// client: AstrometryClient (already logged in)
// tiles: array from splitImageToTiles
// hints: base hints object
// imageWidth, imageHeight: original image dimensions
// progressCallback: function(message, tileIdx)
//
// Returns number of successfully solved tiles.
//----------------------------------------------------------------------------
function solveMultipleTiles(client, tiles, hints, imageWidth, imageHeight, progressCallback) {
   var notify = progressCallback || function() {};
   var successCount = 0;
   var failedCount = 0;
   var startTime = (new Date()).getTime();

   for (var i = 0; i < tiles.length; i++) {
      // Check for user abort (console or dialog abort button)
      processEvents();
      if (console.abortRequested ||
          (typeof client.abortCheck === "function" && client.abortCheck())) {
         throw "Aborted by user";
      }

      var tile = tiles[i];
      tile.status = "solving";
      var tileStartTime = (new Date()).getTime();
      var elapsed = tileStartTime - startTime;
      var prefix = "[" + timestamp() + "] [" + (i + 1) + "/" + tiles.length + "] Tile [" + tile.col + "," + tile.row + "]";
      var timeSuffix = " | " + formatElapsed(elapsed) + " elapsed";
      var completedCount = successCount + failedCount;
      if (completedCount > 0) {
         timeSuffix += " | " + successCount + "/" + completedCount + " solved";
         var avgTime = elapsed / completedCount;
         var remaining = avgTime * (tiles.length - i);
         timeSuffix += " | ~" + formatElapsed(remaining) + " remaining";
      }
      notify(prefix + " uploading..." + timeSuffix, i);

      // Per-tile hints: adjust scale for downsampled tiles
      var tileHints = {};
      for (var key in hints) {
         if (hints.hasOwnProperty(key)) tileHints[key] = hints[key];
      }

      // If downsampled, adjust scale hint
      if (tile.scaleFactor < 1.0 && tileHints.scale_est) {
         tileHints.scale_est = tileHints.scale_est / tile.scaleFactor;
      }

      // Projection-based scale correction for non-rectilinear lenses
      if (tileHints.scale_est && tileHints._projection && tileHints._projection !== "rectilinear") {
         var tileCX = tile.offsetX + tile.tileWidth / 2.0;
         var tileCY = tile.offsetY + tile.tileHeight / 2.0;
         var imgCX = imageWidth / 2.0;
         var imgCY = imageHeight / 2.0;
         var baseScaleArcsec = hints.scale_est || tileHints.scale_est;
         var angleDeg = tileAngleFromCenter(tileCX, tileCY, imgCX, imgCY, baseScaleArcsec);
         tileHints.scale_est = projectionScale(tileHints._projection, tileHints.scale_est, angleDeg);
      }

      // Remove internal hint keys before sending to API
      delete tileHints._projection;

      // Upload
      var subId = client.upload(tile.filePath, tileHints);
      if (subId === null) {
         tile.status = "failed";
         failedCount++;
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] upload failed (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");
         // Rate limit pause
         msleep(2000);
         continue;
      }

      // Poll submission
      elapsed = (new Date()).getTime() - startTime;
      notify(prefix + " waiting for job... | " + formatElapsed(elapsed) + " elapsed", i);
      var jobId = client.pollSubmission(subId);
      if (jobId === null) {
         tile.status = "failed";
         failedCount++;
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] submission timed out (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");
         continue;
      }

      // Poll job
      elapsed = (new Date()).getTime() - startTime;
      notify(prefix + " solving... | " + formatElapsed(elapsed) + " elapsed", i);
      var status = client.pollJob(jobId);
      if (status !== "success") {
         tile.status = "failed";
         failedCount++;
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] solve failed (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");
         msleep(2000);
         continue;
      }

      // Get calibration + WCS
      var calibration = client.getCalibration(jobId);
      var wcsPath = File.systemTempDirectory + "/split_wcs_" + tile.col + "_" + tile.row + ".fits";
      var wcsOk = client.getWcsFile(jobId, wcsPath);

      if (!calibration || !wcsOk) {
         tile.status = "failed";
         failedCount++;
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] result retrieval failed (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");
         continue;
      }

      // Parse WCS
      var wcsData = readWcsFromFits(wcsPath);
      if (!wcsData || wcsData.crval1 === undefined) {
         tile.status = "failed";
         failedCount++;
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] WCS parse failed (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");
         continue;
      }

      // CRPIX reverse transform: undo downsampling
      if (tile.scaleFactor < 1.0) {
         wcsData.crpix1 = wcsData.crpix1 / tile.scaleFactor;
         wcsData.crpix2 = wcsData.crpix2 / tile.scaleFactor;
         // CD matrix scales inversely with pixel size
         if (wcsData.cd1_1 !== undefined) {
            wcsData.cd1_1 *= tile.scaleFactor;
            wcsData.cd1_2 *= tile.scaleFactor;
            wcsData.cd2_1 *= tile.scaleFactor;
            wcsData.cd2_2 *= tile.scaleFactor;
         }
      }

      // Apply tile offset: convert tile-local CRPIX to full image CRPIX
      wcsData.crpix1 += tile.offsetX;
      wcsData.crpix2 += tile.offsetY;

      tile.wcs = wcsData;
      tile.calibration = calibration;
      tile.status = "success";
      successCount++;

      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] solved: RA=" +
         calibration.ra.toFixed(4) + " Dec=" + calibration.dec.toFixed(4) +
         " scale=" + calibration.pixscale.toFixed(3) + " arcsec/px (tile: " + formatElapsed((new Date()).getTime() - tileStartTime) + ", total: " + formatElapsed((new Date()).getTime() - startTime) + ")");

      // Clean up WCS temp file
      try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}

      // Rate limit between submissions
      if (i < tiles.length - 1) msleep(2000);
   }

   var totalElapsed = (new Date()).getTime() - startTime;
   notify("Solved " + successCount + "/" + tiles.length + " tiles | " + formatElapsed(totalElapsed) + " total", -1);
   console.writeln("Tile solving complete: " + successCount + "/" + tiles.length + " succeeded (" + formatElapsed(totalElapsed) + ")");
   return successCount;
}

//----------------------------------------------------------------------------
// mergeWcsSolutions
//
// Generate a unified WCS from multiple tile solutions.
//
// tiles: array of tile objects (with .wcs populated for successful tiles)
// imageWidth, imageHeight: original full image dimensions
//
// Returns wcsResult compatible with applyWCSToImage/setCustomControlPoints,
// or null on failure.
//----------------------------------------------------------------------------
function mergeWcsSolutions(tiles, imageWidth, imageHeight) {
   // 1. Collect control points from all successful tiles
   var controlPoints = [];  // [{px, py, ra, dec}]
   var GRID_STEP = 5;  // 5x5 grid per tile

   for (var t = 0; t < tiles.length; t++) {
      if (tiles[t].status !== "success" || !tiles[t].wcs) continue;

      var tw = tiles[t].wcs;
      var tileW = tiles[t].tileWidth;
      var tileH = tiles[t].tileHeight;
      var offX = tiles[t].offsetX;
      var offY = tiles[t].offsetY;

      // Build WCS object for pixelToRaDec conversion
      // Note: tile.wcs has CRPIX already adjusted to full-image coords
      var wcsObj = {
         crval1: tw.crval1, crval2: tw.crval2,
         crpix1: tw.crpix1, crpix2: tw.crpix2,
         cd1_1: tw.cd1_1 || 0, cd1_2: tw.cd1_2 || 0,
         cd2_1: tw.cd2_1 || 0, cd2_2: tw.cd2_2 || 0,
         sip: null
      };

      // Convert SIP coefficients if present
      if (tw.sipCoeffs && tw.aOrder) {
         wcsObj.sip = {
            a: tw.sipCoeffs.a || [],
            b: tw.sipCoeffs.b || []
         };
      }

      // Generate grid points within tile boundaries
      for (var gy = 0; gy <= GRID_STEP; gy++) {
         for (var gx = 0; gx <= GRID_STEP; gx++) {
            // Local tile pixel coordinates
            var localPx = gx * (tileW - 1) / GRID_STEP;
            var localPy = gy * (tileH - 1) / GRID_STEP;

            // Full image pixel coordinates
            var fullPx = localPx + offX;
            var fullPy = localPy + offY;

            // Convert to RA/DEC using tile WCS
            var raDec = pixelToRaDec(wcsObj, fullPx, fullPy, imageHeight);
            if (raDec) {
               controlPoints.push({
                  px: fullPx,
                  py: fullPy,
                  ra: raDec[0],
                  dec: raDec[1]
               });
            }
         }
      }
   }

   console.writeln("Collected " + controlPoints.length + " control points from tiles");

   if (controlPoints.length < 4) {
      console.writeln("ERROR: Not enough control points for WCS fitting");
      return null;
   }

   // 2. Fit unified WCS using WCSFitter
   var fitter = new WCSFitter(controlPoints, imageWidth, imageHeight);
   var result = fitter.solve();

   if (!result || !result.success) {
      console.writeln("ERROR: WCS fitting failed: " + (result ? result.message : "unknown error"));
      return null;
   }

   console.writeln("Unified WCS fitted: CRVAL=(" + result.crval1.toFixed(6) + ", " +
      result.crval2.toFixed(6) + ") RMS=" + result.rmsArcsec.toFixed(2) + " arcsec");

   return result;
}

//============================================================================
// Phase 4: Reliability and advanced features
//============================================================================

//----------------------------------------------------------------------------
// Projection-based effective scale correction
//
// For non-rectilinear projections, the effective pixel scale varies with
// angular distance from the optical axis.
//
// projection: "rectilinear", "equisolid", "equidistant", "stereographic"
// baseScale: pixel scale at optical center (arcsec/px)
// thetaDeg: angular distance from optical center (degrees)
//
// Returns effective scale at the given angle (arcsec/px)
//----------------------------------------------------------------------------
function projectionScale(projection, baseScale, thetaDeg) {
   var theta = thetaDeg * Math.PI / 180.0;
   if (theta < 0.001) return baseScale; // At center, all projections have same scale

   switch (projection) {
      case "rectilinear":
         // gnomonic: scale * 1/cos^2(theta)
         var cosT = Math.cos(theta);
         if (Math.abs(cosT) < 1e-6) return baseScale * 1000; // near singularity
         return baseScale / (cosT * cosT);
      case "equisolid":
         // equisolid: scale * 1/cos(theta/2)
         return baseScale / Math.cos(theta / 2.0);
      case "equidistant":
         // equidistant: scale is constant
         return baseScale;
      case "stereographic":
         // stereographic: scale * 1/cos^2(theta/2)
         var cosHalf = Math.cos(theta / 2.0);
         return baseScale / (cosHalf * cosHalf);
      default:
         return baseScale;
   }
}

//----------------------------------------------------------------------------
// Compute angular distance of tile center from image center
//
// tileCenterX, tileCenterY: tile center in pixels
// imageCenterX, imageCenterY: image center in pixels
// pixelScaleArcsec: pixel scale at center (arcsec/px)
//
// Returns angle in degrees
//----------------------------------------------------------------------------
function tileAngleFromCenter(tileCenterX, tileCenterY, imageCenterX, imageCenterY, pixelScaleArcsec) {
   var dx = tileCenterX - imageCenterX;
   var dy = tileCenterY - imageCenterY;
   var distPx = Math.sqrt(dx * dx + dy * dy);
   return distPx * pixelScaleArcsec / 3600.0;
}

//----------------------------------------------------------------------------
// retryFailedTiles
//
// 2nd pass: retry failed tiles using hints from successful neighbors.
//
// client: AstrometryClient (already logged in)
// tiles: array of tile objects (some with status "success", others "failed")
// baseHints: original hints
// imageWidth, imageHeight: full image dimensions
// progressCallback: function(message, tileIdx)
//
// Returns number of additionally solved tiles.
//----------------------------------------------------------------------------
function retryFailedTiles(client, tiles, baseHints, imageWidth, imageHeight, progressCallback) {
   var notify = progressCallback || function() {};
   var additionalSolved = 0;

   // Collect failed tiles
   var failedTiles = [];
   for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].status === "failed") failedTiles.push(tiles[i]);
   }
   if (failedTiles.length === 0) return 0;

   // Collect successful tiles for hint computation
   var successTiles = [];
   for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].status === "success" && tiles[i].wcs) successTiles.push(tiles[i]);
   }
   if (successTiles.length === 0) return 0;

   console.writeln("");
   console.writeln("<b>Pass 2: Retrying " + failedTiles.length + " failed tiles with refined hints...</b>");

   // Median pixel scale from successful tiles (for false positive filter)
   var scales = [];
   for (var i = 0; i < successTiles.length; i++) {
      if (successTiles[i].calibration && successTiles[i].calibration.pixscale) {
         scales.push(successTiles[i].calibration.pixscale);
      }
   }
   scales.sort(function(a, b) { return a - b; });
   var medianScale = scales.length > 0 ? scales[Math.floor(scales.length / 2)] : 0;

   for (var fi = 0; fi < failedTiles.length; fi++) {
      var tile = failedTiles[fi];
      tile.status = "solving";
      notify("Pass 2 [" + (fi + 1) + "/" + failedTiles.length + "] Tile [" + tile.col + "," + tile.row + "] retrying...", fi);

      // Find nearest successful tile(s) and compute RA/DEC for this tile's center
      var tileCenterX = tile.offsetX + tile.tileWidth / 2.0;
      var tileCenterY = tile.offsetY + tile.tileHeight / 2.0;

      var bestDist = Infinity;
      var bestTile = null;
      for (var si = 0; si < successTiles.length; si++) {
         var st = successTiles[si];
         var stCenterX = st.offsetX + st.tileWidth / 2.0;
         var stCenterY = st.offsetY + st.tileHeight / 2.0;
         var dx = tileCenterX - stCenterX;
         var dy = tileCenterY - stCenterY;
         var dist = Math.sqrt(dx * dx + dy * dy);
         if (dist < bestDist) {
            bestDist = dist;
            bestTile = st;
         }
      }

      if (!bestTile) {
         tile.status = "failed";
         continue;
      }

      // Compute RA/DEC of failed tile center using nearest successful tile's WCS
      var wcsObj = {
         crval1: bestTile.wcs.crval1, crval2: bestTile.wcs.crval2,
         crpix1: bestTile.wcs.crpix1, crpix2: bestTile.wcs.crpix2,
         cd1_1: bestTile.wcs.cd1_1 || 0, cd1_2: bestTile.wcs.cd1_2 || 0,
         cd2_1: bestTile.wcs.cd2_1 || 0, cd2_2: bestTile.wcs.cd2_2 || 0,
         sip: null
      };
      var raDec = pixelToRaDec(wcsObj, tileCenterX, tileCenterY, imageHeight);
      if (!raDec) {
         tile.status = "failed";
         continue;
      }

      // Build refined hints
      var retryHints = {};
      for (var key in baseHints) {
         if (baseHints.hasOwnProperty(key)) retryHints[key] = baseHints[key];
      }
      retryHints.center_ra = raDec[0];
      retryHints.center_dec = raDec[1];
      retryHints.radius = 2; // Narrow search radius

      // Narrow scale range if we have it
      if (medianScale > 0) {
         retryHints.scale_units = "arcsecperpix";
         retryHints.scale_est = medianScale;
         retryHints.scale_err = 20; // Tighter error margin
      }

      // Adjust scale for downsampled tiles
      if (tile.scaleFactor < 1.0 && retryHints.scale_est) {
         retryHints.scale_est = retryHints.scale_est / tile.scaleFactor;
      }

      // Remove internal hint keys before sending to API
      delete retryHints._projection;

      // Upload
      var subId = client.upload(tile.filePath, retryHints);
      if (subId === null) {
         tile.status = "failed";
         msleep(2000);
         continue;
      }

      // Poll
      var jobId = client.pollSubmission(subId);
      if (jobId === null) { tile.status = "failed"; continue; }

      var status = client.pollJob(jobId);
      if (status !== "success") { tile.status = "failed"; msleep(2000); continue; }

      // Get results
      var calibration = client.getCalibration(jobId);
      var wcsPath = File.systemTempDirectory + "/split_wcs_retry_" + tile.col + "_" + tile.row + ".fits";
      var wcsOk = client.getWcsFile(jobId, wcsPath);

      if (!calibration || !wcsOk) { tile.status = "failed"; continue; }

      var wcsData = readWcsFromFits(wcsPath);
      if (!wcsData || wcsData.crval1 === undefined) { tile.status = "failed"; continue; }

      // False positive filter: check scale ratio
      if (medianScale > 0 && calibration.pixscale) {
         var scaleRatio = calibration.pixscale / medianScale;
         if (scaleRatio < 0.3 || scaleRatio > 3.0) {
            console.writeln("  Tile [" + tile.col + "," + tile.row + "] rejected: scale ratio " + scaleRatio.toFixed(2) + " out of range");
            tile.status = "failed";
            try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}
            continue;
         }
      }

      // False positive filter: check coordinate deviation
      var solvedRa = calibration.ra;
      var solvedDec = calibration.dec;
      var coordDev = angularSeparation([raDec[0], raDec[1]], [solvedRa, solvedDec]);
      if (coordDev > 5.0) { // More than 5 degrees off
         console.writeln("  Tile [" + tile.col + "," + tile.row + "] rejected: coordinate deviation " + coordDev.toFixed(2) + " deg");
         tile.status = "failed";
         try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}
         continue;
      }

      // CRPIX reverse transform + offset (same as pass 1)
      if (tile.scaleFactor < 1.0) {
         wcsData.crpix1 = wcsData.crpix1 / tile.scaleFactor;
         wcsData.crpix2 = wcsData.crpix2 / tile.scaleFactor;
         if (wcsData.cd1_1 !== undefined) {
            wcsData.cd1_1 *= tile.scaleFactor;
            wcsData.cd1_2 *= tile.scaleFactor;
            wcsData.cd2_1 *= tile.scaleFactor;
            wcsData.cd2_2 *= tile.scaleFactor;
         }
      }
      wcsData.crpix1 += tile.offsetX;
      wcsData.crpix2 += tile.offsetY;

      tile.wcs = wcsData;
      tile.calibration = calibration;
      tile.status = "success";
      additionalSolved++;

      console.writeln("  Tile [" + tile.col + "," + tile.row + "] solved (pass 2): RA=" +
         calibration.ra.toFixed(4) + " Dec=" + calibration.dec.toFixed(4) +
         " scale=" + calibration.pixscale.toFixed(3) + " arcsec/px");

      try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}
      if (fi < failedTiles.length - 1) msleep(2000);
   }

   console.writeln("Pass 2 complete: " + additionalSolved + " additional tiles solved");
   return additionalSolved;
}

//----------------------------------------------------------------------------
// validateOverlap
//
// Check WCS consistency in overlap regions between adjacent tiles.
// Tiles whose WCS disagrees with neighbors are flagged and optionally excluded.
//
// tiles: array of tile objects
// imageWidth, imageHeight: full image dimensions
// toleranceArcsec: maximum allowed RA/DEC deviation (default 5 arcsec)
//
// Returns number of tiles invalidated.
//----------------------------------------------------------------------------
function validateOverlap(tiles, imageWidth, imageHeight, toleranceArcsec) {
   if (typeof toleranceArcsec === "undefined") toleranceArcsec = 5.0;

   var successTiles = [];
   for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].status === "success" && tiles[i].wcs) successTiles.push(tiles[i]);
   }
   if (successTiles.length < 2) return 0;

   console.writeln("");
   console.writeln("<b>Validating overlap consistency...</b>");

   // For each pair of adjacent tiles, check overlap region
   var deviations = []; // {tileIdx, maxDevArcsec}
   for (var i = 0; i < successTiles.length; i++) {
      deviations.push({ idx: i, maxDev: 0, pairCount: 0, totalDev: 0 });
   }

   var pairsChecked = 0;
   for (var i = 0; i < successTiles.length; i++) {
      for (var j = i + 1; j < successTiles.length; j++) {
         var ti = successTiles[i];
         var tj = successTiles[j];

         // Check if tiles overlap
         var iX0 = ti.offsetX, iX1 = ti.offsetX + ti.tileWidth;
         var iY0 = ti.offsetY, iY1 = ti.offsetY + ti.tileHeight;
         var jX0 = tj.offsetX, jX1 = tj.offsetX + tj.tileWidth;
         var jY0 = tj.offsetY, jY1 = tj.offsetY + tj.tileHeight;

         var overlapX0 = Math.max(iX0, jX0);
         var overlapX1 = Math.min(iX1, jX1);
         var overlapY0 = Math.max(iY0, jY0);
         var overlapY1 = Math.min(iY1, jY1);

         if (overlapX0 >= overlapX1 || overlapY0 >= overlapY1) continue; // No overlap

         // Sample 3x3 points in overlap region
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

               var dev = angularSeparation(rdI, rdJ) * 3600.0; // arcsec
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
         var label = "[" + ti.col + "," + ti.row + "]-[" + tj.col + "," + tj.row + "]";
         if (maxDev > toleranceArcsec) {
            console.writeln("  " + label + ": max deviation " + maxDev.toFixed(1) + "\" > " + toleranceArcsec.toFixed(1) + "\" FAIL");
         } else {
            console.writeln("  " + label + ": max deviation " + maxDev.toFixed(1) + "\" OK");
         }
      }
   }

   // Identify tiles with consistently high deviation (outliers)
   var invalidated = 0;
   for (var i = 0; i < successTiles.length; i++) {
      if (deviations[i].pairCount === 0) continue;
      var avgDev = deviations[i].totalDev / deviations[i].pairCount;
      if (avgDev > toleranceArcsec * 3) {
         // This tile is consistently inconsistent - likely a false solve
         console.writeln("  Tile [" + successTiles[i].col + "," + successTiles[i].row +
            "] INVALIDATED: avg deviation " + avgDev.toFixed(1) + "\" exceeds threshold");
         successTiles[i].status = "failed";
         successTiles[i].wcs = null;
         invalidated++;
      }
   }

   console.writeln("Overlap validation: " + pairsChecked + " pairs checked, " + invalidated + " tiles invalidated");
   return invalidated;
}

// Load equipment database
// Uses __equipmentData__ from #include "equipment_data.jsh"
function loadEquipmentDB() {
   if (typeof __equipmentData__ !== "undefined" && __equipmentData__) {
      console.writeln("Loaded equipment DB: " +
         __equipmentData__.cameras.length + " cameras, " +
         __equipmentData__.lenses.length + " lenses");
      return __equipmentData__;
   }
   console.writeln("WARNING: Equipment DB not available (__equipmentData__ not defined)");
   return null;
}

// Compute pixel scale from camera pixel pitch and lens focal length
// Returns arcsec/pixel
function computePixelScale(pixelPitchUm, focalLengthMm) {
   if (pixelPitchUm <= 0 || focalLengthMm <= 0) return 0;
   return 206.265 * pixelPitchUm / focalLengthMm;
}

// Compute diagonal FOV in degrees
function computeDiagonalFov(sensorWidthPx, sensorHeightPx, pixelScaleArcsec) {
   if (pixelScaleArcsec <= 0) return 0;
   var diagPx = Math.sqrt(sensorWidthPx * sensorWidthPx + sensorHeightPx * sensorHeightPx);
   // Use proper trigonometric formula: FOV = 2 * arctan(half_diag_angular)
   // pixelScale [arcsec/px] -> half diagonal angle [rad]
   var halfDiagRad = diagPx * pixelScaleArcsec / 2.0 / 206265.0;
   // For rectilinear lenses, tan(theta) = r, so FOV = 2 * arctan(r)
   return 2.0 * Math.atan(halfDiagRad) * 180.0 / Math.PI;
}

// Recommend grid size based on FOV
// Returns {cols, rows, reason}
function recommendGrid(diagFovDeg, imageWidth, imageHeight) {
   // astrometry.net works best with FOV < ~10 degrees per tile
   // For very wide fields, split into more tiles
   if (diagFovDeg <= 0) return { cols: 1, rows: 1, reason: "FOV unknown" };
   if (diagFovDeg <= 10) return { cols: 1, rows: 1, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV - single solve" };
   if (diagFovDeg <= 20) return { cols: 2, rows: 2, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 40) return { cols: 3, rows: 2, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 60) return { cols: 4, rows: 3, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 90) return { cols: 6, rows: 4, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   if (diagFovDeg <= 120) return { cols: 8, rows: 6, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV" };
   return { cols: 12, rows: 8, reason: diagFovDeg.toFixed(1) + "\u00b0 FOV (full-sky)" };
}

// Find grid preset index matching cols x rows, or -1
function findGridPresetIndex(presets, cols, rows) {
   for (var i = 0; i < presets.length; i++) {
      if (presets[i][0] === cols && presets[i][1] === rows) return i;
   }
   return -1;
}

//============================================================================
// Main dialog
//============================================================================

var SETTINGS_KEY = "SplitImageSolver";

function SplitSolverDialog() {
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = TITLE + " v" + VERSION;

   var self = this;

   // Load saved settings
   var savedApiKey = Settings.read(SETTINGS_KEY + "/apiKey", DataType_String);
   var savedScale = Settings.read(SETTINGS_KEY + "/pixelScale", DataType_Double);

   // ---- Target image ----
   var targetWindow = ImageWindow.activeWindow;

   this.targetLabel = new Label(this);
   this.targetLabel.text = "Target:";
   this.targetLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.targetLabel.setFixedWidth(80);

   this.targetEdit = new Edit(this);
   this.targetEdit.readOnly = true;
   this.targetEdit.text = targetWindow.isNull ? "(No active image)" : targetWindow.mainView.id;

   var targetSizer = new HorizontalSizer;
   targetSizer.spacing = 6;
   targetSizer.add(this.targetLabel);
   targetSizer.add(this.targetEdit, 100);

   // ---- API key (stored internally, shown as status) ----
   this._apiKey = savedApiKey || "";

   this.apiKeyLabel = new Label(this);
   this.apiKeyLabel.text = "API Key:";
   this.apiKeyLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.apiKeyLabel.setFixedWidth(80);

   this.apiKeyStatus = new Label(this);
   this.apiKeyStatus.text = this._apiKey.length > 0 ? "Configured" : "Not set";
   this.apiKeyStatus.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.apiKeySettingsButton = new ToolButton(this);
   this.apiKeySettingsButton.icon = this.scaledResource(":/icons/wrench.png");
   this.apiKeySettingsButton.setScaledFixedSize(24, 24);
   this.apiKeySettingsButton.toolTip = "Configure API key";
   this.apiKeySettingsButton.onClick = function() {
      var d = new Dialog;
      d.windowTitle = "API Key Settings";

      var infoLabel = new Label(d);
      infoLabel.text = "Enter your astrometry.net API key.\nGet one free at nova.astrometry.net";
      infoLabel.useRichText = false;

      var keyEdit = new Edit(d);
      keyEdit.text = self._apiKey;
      keyEdit.passwordMode = true;
      keyEdit.setMinWidth(300);
      keyEdit.toolTip = "Your nova.astrometry.net API key";

      var showCheck = new CheckBox(d);
      showCheck.text = "Show key";
      showCheck.checked = false;
      showCheck.onCheck = function(checked) {
         keyEdit.passwordMode = !checked;
      };

      var okButton = new PushButton(d);
      okButton.text = "OK";
      okButton.icon = d.scaledResource(":/icons/ok.png");
      okButton.onClick = function() { d.ok(); };

      var cancelButton = new PushButton(d);
      cancelButton.text = "Cancel";
      cancelButton.icon = d.scaledResource(":/icons/cancel.png");
      cancelButton.onClick = function() { d.cancel(); };

      var btnSizer = new HorizontalSizer;
      btnSizer.addStretch();
      btnSizer.spacing = 6;
      btnSizer.add(okButton);
      btnSizer.add(cancelButton);

      d.sizer = new VerticalSizer;
      d.sizer.margin = 12;
      d.sizer.spacing = 8;
      d.sizer.add(infoLabel);
      d.sizer.add(keyEdit);
      d.sizer.add(showCheck);
      d.sizer.addSpacing(4);
      d.sizer.add(btnSizer);

      if (d.execute()) {
         var newKey = keyEdit.text.trim();
         self._apiKey = newKey;
         Settings.write(SETTINGS_KEY + "/apiKey", DataType_String, newKey);
         self.apiKeyStatus.text = newKey.length > 0 ? "Configured" : "Not set";
      }
   };

   var apiKeySizer = new HorizontalSizer;
   apiKeySizer.spacing = 6;
   apiKeySizer.add(this.apiKeyLabel);
   apiKeySizer.add(this.apiKeyStatus, 100);
   apiKeySizer.add(this.apiKeySettingsButton);

   // ---- Equipment (Camera + Lens) ----
   var equipDB = loadEquipmentDB();
   this.equipDB = equipDB;

   this.cameraLabel = new Label(this);
   this.cameraLabel.text = "Camera:";
   this.cameraLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.cameraLabel.setFixedWidth(80);

   this.cameraCombo = new ComboBox(this);
   this.cameraCombo.addItem("(Select)");
   if (equipDB && equipDB.cameras) {
      for (var ci = 0; ci < equipDB.cameras.length; ci++) {
         this.cameraCombo.addItem(equipDB.cameras[ci].name);
      }
   }
   this.cameraCombo.currentItem = 0;

   // Auto-detect camera from INSTRUME header
   if (!targetWindow.isNull && equipDB && equipDB.cameras) {
      var keywords = targetWindow.keywords;
      for (var ki = 0; ki < keywords.length; ki++) {
         if (keywords[ki].name === "INSTRUME") {
            var instrVal = keywords[ki].value.trim().replace(/^'|'$/g, "").trim();
            // Find longest matching instrume to avoid partial matches
            // e.g., "Sony ILCE-7RM5" must match α7R V, not α7 ("Sony ILCE-7")
            var bestCi = -1;
            var bestLen = 0;
            for (var ci = 0; ci < equipDB.cameras.length; ci++) {
               var pat = equipDB.cameras[ci].instrume;
               if (pat.length > 0 && instrVal.indexOf(pat) >= 0 && pat.length > bestLen) {
                  bestCi = ci;
                  bestLen = pat.length;
               }
            }
            if (bestCi >= 0) {
               this.cameraCombo.currentItem = bestCi + 1; // +1 for "(select)" entry
               console.writeln("Auto-detected camera: " + equipDB.cameras[bestCi].name);
            }
            break;
         }
      }
   }

   this.lensLabel = new Label(this);
   this.lensLabel.text = "Lens:";
   this.lensLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.lensCombo = new ComboBox(this);
   this.lensCombo.addItem("(Select)");
   if (equipDB && equipDB.lenses) {
      for (var li = 0; li < equipDB.lenses.length; li++) {
         this.lensCombo.addItem(equipDB.lenses[li].name);
      }
   }
   this.lensCombo.currentItem = 0;

   // Auto-detect lens from FOCALLEN header
   if (!targetWindow.isNull && equipDB && equipDB.lenses) {
      var keywords = targetWindow.keywords;
      for (var ki = 0; ki < keywords.length; ki++) {
         if (keywords[ki].name === "FOCALLEN") {
            var focalVal = parseFloat(keywords[ki].value);
            if (!isNaN(focalVal) && focalVal > 0) {
               // Find closest matching focal length
               var bestIdx = -1;
               var bestDiff = Infinity;
               for (var li = 0; li < equipDB.lenses.length; li++) {
                  var diff = Math.abs(equipDB.lenses[li].focal_length - focalVal);
                  if (diff < bestDiff && equipDB.lenses[li].focal_length > 0) {
                     bestDiff = diff;
                     bestIdx = li;
                  }
               }
               // Match if within 10% of focal length
               if (bestIdx >= 0 && bestDiff / focalVal < 0.10) {
                  this.lensCombo.currentItem = bestIdx + 1;
                  console.writeln("Auto-detected lens: " + equipDB.lenses[bestIdx].name + " (FOCALLEN=" + focalVal + "mm)");
               }
            }
            break;
         }
      }
   }

   var equipSizer = new HorizontalSizer;
   equipSizer.spacing = 6;
   equipSizer.add(this.cameraLabel);
   equipSizer.add(this.cameraCombo);
   equipSizer.addSpacing(12);
   equipSizer.add(this.lensLabel);
   equipSizer.add(this.lensCombo);
   equipSizer.addStretch();

   // ---- FOV info + recommended grid ----
   this.fovInfoLabel = new Label(this);
   this.fovInfoLabel.text = "";
   this.fovInfoLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   // Need imageWidth/imageHeight for scale correction when image is resampled
   var imageWidth = targetWindow.isNull ? 0 : targetWindow.mainView.image.width;
   var imageHeight = targetWindow.isNull ? 0 : targetWindow.mainView.image.height;

   // Update scale and FOV when camera/lens selection changes
   var updateScaleAndFov = function() {
      var camIdx = self.cameraCombo.currentItem - 1; // -1 for "(select)"
      var lensIdx = self.lensCombo.currentItem - 1;
      if (!equipDB) return;

      if (camIdx >= 0 && camIdx < equipDB.cameras.length &&
          lensIdx >= 0 && lensIdx < equipDB.lenses.length) {
         var cam = equipDB.cameras[camIdx];
         var lens = equipDB.lenses[lensIdx];
         if (cam.pixel_pitch > 0 && lens.focal_length > 0) {
            var nativeScale = computePixelScale(cam.pixel_pitch, lens.focal_length);

            // Correct for resampled images (e.g., drizzle/stacking)
            // If actual image is larger than native sensor, pixels are smaller
            var ps = nativeScale;
            var scaleNote = "";
            if (imageWidth > 0 && cam.sensor_width > 0 && imageWidth !== cam.sensor_width) {
               var resampleRatio = cam.sensor_width / imageWidth;
               ps = nativeScale * resampleRatio;
               scaleNote = " (native: " + nativeScale.toFixed(3) + ", image: " +
                  imageWidth + "x" + imageHeight + " vs sensor: " +
                  cam.sensor_width + "x" + cam.sensor_height + ")";
               console.writeln("Scale corrected for resampled image: " +
                  nativeScale.toFixed(3) + " -> " + ps.toFixed(3) + " arcsec/px" + scaleNote);
            }
            self.scaleEdit.text = ps.toFixed(3);

            // Use actual image dimensions for FOV and grid recommendation
            var sW = imageWidth > 0 ? imageWidth : cam.sensor_width;
            var sH = imageHeight > 0 ? imageHeight : cam.sensor_height;
            var diagFov = computeDiagonalFov(sW, sH, ps);
            var rec = recommendGrid(diagFov, sW, sH);
            self.fovInfoLabel.text = "Scale: " + ps.toFixed(3) + " arcsec/px | FOV: " +
               diagFov.toFixed(1) + "\u00b0 | Recommended: " + rec.cols + "x" + rec.rows;

            // Auto-select recommended grid
            var presetIdx = findGridPresetIndex(self.gridPresets, rec.cols, rec.rows);
            if (presetIdx >= 0) {
               self.gridCombo.currentItem = presetIdx;
            }
         }
      } else {
         self.fovInfoLabel.text = "";
      }
   };

   this.cameraCombo.onItemSelected = function() { updateScaleAndFov(); };
   this.lensCombo.onItemSelected = function() { updateScaleAndFov(); };

   // Trigger initial update if both auto-detected
   if (this.cameraCombo.currentItem > 0 && this.lensCombo.currentItem > 0) {
      updateScaleAndFov();
   }

   // ---- Pixel scale ----
   this.scaleLabel = new Label(this);
   this.scaleLabel.text = "Scale:";
   this.scaleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.scaleLabel.setFixedWidth(80);

   this.scaleEdit = new Edit(this);
   this.scaleEdit.text = (savedScale && savedScale > 0) ? savedScale.toFixed(3) : "";
   this.scaleEdit.setFixedWidth(100);
   this.scaleEdit.toolTip = "Pixel scale (arcsec/px). Leave blank for blind solve";

   this.scaleUnitLabel = new Label(this);
   this.scaleUnitLabel.text = "arcsec/px (optional)";

   this.scaleErrorLabel = new Label(this);
   this.scaleErrorLabel.text = "Error:";
   this.scaleErrorLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.scaleErrorEdit = new Edit(this);
   this.scaleErrorEdit.text = "30";
   this.scaleErrorEdit.setFixedWidth(50);
   this.scaleErrorEdit.toolTip = "Scale estimation error (%)";

   this.scaleErrorUnitLabel = new Label(this);
   this.scaleErrorUnitLabel.text = "%";

   var scaleSizer = new HorizontalSizer;
   scaleSizer.spacing = 6;
   scaleSizer.add(this.scaleLabel);
   scaleSizer.add(this.scaleEdit);
   scaleSizer.add(this.scaleUnitLabel);
   scaleSizer.addSpacing(12);
   scaleSizer.add(this.scaleErrorLabel);
   scaleSizer.add(this.scaleErrorEdit);
   scaleSizer.add(this.scaleErrorUnitLabel);
   scaleSizer.addStretch();

   // ---- Object name search ----
   this.objectLabel = new Label(this);
   this.objectLabel.text = "Object:";
   this.objectLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.objectLabel.setFixedWidth(80);

   this.objectEdit = new Edit(this);
   this.objectEdit.setMinWidth(150);
   this.objectEdit.toolTip = "Object name (e.g. M31, NGC 7000). Sesame search fills RA/DEC automatically";

   this.searchButton = new PushButton(this);
   this.searchButton.text = "Search";
   this.searchButton.onClick = function() {
      var name = self.objectEdit.text.trim();
      if (name.length === 0) return;

      console.writeln("Sesame searching: " + name);
      var result = searchObjectCoordinates(name);
      if (result) {
         self.raEdit.text = raToHMS(result.ra);
         self.decEdit.text = decToDMS(result.dec);
         console.writeln("  Found: RA=" + raToHMS(result.ra) + " Dec=" + decToDMS(result.dec));
      } else {
         console.writeln("  Not found: " + name);
         var msg = new MessageBox("Object '" + name + "' not found.", TITLE, StdIcon_Warning, StdButton_Ok);
         msg.execute();
      }
   };

   var objectSizer = new HorizontalSizer;
   objectSizer.spacing = 6;
   objectSizer.add(this.objectLabel);
   objectSizer.add(this.objectEdit, 100);
   objectSizer.add(this.searchButton);

   // ---- RA / DEC ----
   this.raLabel = new Label(this);
   this.raLabel.text = "RA:";
   this.raLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.raLabel.setFixedWidth(80);

   this.raEdit = new Edit(this);
   this.raEdit.setFixedWidth(150);
   this.raEdit.toolTip = "RA hint (HH MM SS.ss or degrees). Optional";

   this.decLabel = new Label(this);
   this.decLabel.text = "DEC:";
   this.decLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.decEdit = new Edit(this);
   this.decEdit.setFixedWidth(150);
   this.decEdit.toolTip = "DEC hint (+DD MM SS.s or degrees). Optional";

   this.radiusLabel = new Label(this);
   this.radiusLabel.text = "Radius:";
   this.radiusLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.radiusEdit = new Edit(this);
   this.radiusEdit.text = "15";
   this.radiusEdit.setFixedWidth(50);
   this.radiusEdit.toolTip = "Search radius (degrees)";

   this.radiusUnitLabel = new Label(this);
   this.radiusUnitLabel.text = "deg";

   var coordSizer = new HorizontalSizer;
   coordSizer.spacing = 6;
   coordSizer.add(this.raLabel);
   coordSizer.add(this.raEdit);
   coordSizer.addSpacing(6);
   coordSizer.add(this.decLabel);
   coordSizer.add(this.decEdit);
   coordSizer.addSpacing(6);
   coordSizer.add(this.radiusLabel);
   coordSizer.add(this.radiusEdit);
   coordSizer.add(this.radiusUnitLabel);
   coordSizer.addStretch();

   // ---- Grid / Split mode ----
   this.gridLabel = new Label(this);
   this.gridLabel.text = "Grid:";
   this.gridLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.gridLabel.setFixedWidth(80);

   this.gridCombo = new ComboBox(this);
   this.gridCombo.addItem("1x1 (Single)");
   this.gridCombo.addItem("2x2");
   this.gridCombo.addItem("3x3");
   this.gridCombo.addItem("4x4");
   this.gridCombo.addItem("2x1");
   this.gridCombo.addItem("3x2");
   this.gridCombo.addItem("4x3");
   this.gridCombo.addItem("6x4");
   this.gridCombo.addItem("8x6");
   this.gridCombo.addItem("12x8");
   this.gridCombo.currentItem = 0;
   this.gridCombo.toolTip = "Image split grid (cols x rows). Splitting wide-angle images improves solve success rate";

   // Grid presets: [cols, rows]
   this.gridPresets = [
      [1, 1], [2, 2], [3, 3], [4, 4],
      [2, 1], [3, 2], [4, 3], [6, 4], [8, 6], [12, 8]
   ];

   this.overlapLabel = new Label(this);
   this.overlapLabel.text = "Overlap:";
   this.overlapLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.overlapEdit = new Edit(this);
   this.overlapEdit.text = "200";
   this.overlapEdit.setFixedWidth(60);
   this.overlapEdit.toolTip = "Overlap between tiles (px)";

   this.overlapUnitLabel = new Label(this);
   this.overlapUnitLabel.text = "px";

   var gridSizer = new HorizontalSizer;
   gridSizer.spacing = 6;
   gridSizer.add(this.gridLabel);
   gridSizer.add(this.gridCombo);
   gridSizer.addSpacing(12);
   gridSizer.add(this.overlapLabel);
   gridSizer.add(this.overlapEdit);
   gridSizer.add(this.overlapUnitLabel);
   gridSizer.addStretch();

   // ---- Downsample ----
   this.downsampleLabel = new Label(this);
   this.downsampleLabel.text = "Downsample:";
   this.downsampleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.downsampleLabel.setFixedWidth(80);

   this.downsampleCombo = new ComboBox(this);
   this.downsampleCombo.addItem("Auto");
   this.downsampleCombo.addItem("2");
   this.downsampleCombo.addItem("4");
   this.downsampleCombo.currentItem = 0;
   this.downsampleCombo.toolTip = "Downsample factor before API upload. Auto-downsample is applied in split mode";

   // ---- SIP order ----
   this.sipLabel = new Label(this);
   this.sipLabel.text = "SIP Order:";
   this.sipLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.sipCombo = new ComboBox(this);
   this.sipCombo.addItem("2 (recommended)");
   this.sipCombo.addItem("3");
   this.sipCombo.addItem("4");
   this.sipCombo.currentItem = 0;
   this.sipCombo.toolTip = "SIP distortion correction polynomial order (tweak_order)";

   var optionSizer = new HorizontalSizer;
   optionSizer.spacing = 6;
   optionSizer.add(this.downsampleLabel);
   optionSizer.add(this.downsampleCombo);
   optionSizer.addSpacing(12);
   optionSizer.add(this.sipLabel);
   optionSizer.add(this.sipCombo);
   optionSizer.addStretch();

   // ---- Progress display ----
   this.progressLabel = new Label(this);
   this.progressLabel.text = "";
   this.progressLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   // ---- Buttons ----
   this._abortRequested = false;

   this.solveButton = new PushButton(this);
   this.solveButton.text = "Solve";
   this.solveButton.icon = this.scaledResource(":/icons/execute.png");
   this.solveButton.onClick = function() {
      self.doSolve();
   };

   this.abortButton = new PushButton(this);
   this.abortButton.text = "Abort";
   this.abortButton.icon = this.scaledResource(":/icons/cancel.png");
   this.abortButton.toolTip = "Abort the current solve operation";
   this.abortButton.hide();
   this.abortButton.onClick = function() {
      self._abortRequested = true;
      self.progressLabel.text = "Aborting...";
   };

   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.icon = this.scaledResource(":/icons/close.png");
   this.closeButton.onClick = function() {
      if (self.solveButton.enabled) {
         self.cancel();
      } else {
         // During solve, Close acts as abort
         self._abortRequested = true;
         self.progressLabel.text = "Aborting...";
      }
   };

   var buttonSizer = new HorizontalSizer;
   buttonSizer.spacing = 6;
   buttonSizer.addStretch();
   buttonSizer.add(this.solveButton);
   buttonSizer.add(this.abortButton);
   buttonSizer.add(this.closeButton);

   // ---- Layout ----
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(targetSizer);
   this.sizer.add(apiKeySizer);
   this.sizer.add(equipSizer);
   this.sizer.add(this.fovInfoLabel);
   this.sizer.add(scaleSizer);
   this.sizer.add(objectSizer);
   this.sizer.add(coordSizer);
   this.sizer.add(gridSizer);
   this.sizer.add(optionSizer);
   this.sizer.addSpacing(4);
   this.sizer.add(this.progressLabel);
   this.sizer.addSpacing(4);
   this.sizer.add(buttonSizer);

   this.adjustToContents();
   this.setMinWidth(500);
}

SplitSolverDialog.prototype = new Dialog;

//============================================================================
// Solve execution
//============================================================================

SplitSolverDialog.prototype.doSolve = function() {
   var self = this;

   // Validation
   var targetWindow = ImageWindow.activeWindow;
   if (targetWindow.isNull) {
      var msg = new MessageBox("Please open an image before running.", TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
      return;
   }

   var apiKey = this._apiKey.trim();
   if (apiKey.length === 0) {
      var msg = new MessageBox("Please configure your API key first.\nClick the wrench icon next to 'API Key'.", TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
      return;
   }

   // Build hint parameters
   var hints = {};
   hints.tweak_order = [2, 3, 4][this.sipCombo.currentItem];

   // Downsample (for single mode only; split mode uses auto-downsample per tile)
   if (this.downsampleCombo.currentItem === 1) hints.downsample_factor = 2;
   else if (this.downsampleCombo.currentItem === 2) hints.downsample_factor = 4;

   // Scale
   var scaleText = this.scaleEdit.text.trim();
   if (scaleText.length > 0) {
      var scale = parseFloat(scaleText);
      if (!isNaN(scale) && scale > 0) {
         hints.scale_units = "arcsecperpix";
         hints.scale_est = scale;
         var errText = this.scaleErrorEdit.text.trim();
         var errPct = parseFloat(errText);
         hints.scale_err = (!isNaN(errPct) && errPct > 0) ? errPct : 30;
         Settings.write(SETTINGS_KEY + "/pixelScale", DataType_Double, scale);
      }
   }

   // RA/DEC hints
   var ra = parseRAInput(this.raEdit.text);
   var dec = parseDECInput(this.decEdit.text);
   if (ra !== null && dec !== null) {
      hints.center_ra = ra;
      hints.center_dec = dec;
      var radius = parseFloat(this.radiusEdit.text);
      hints.radius = (!isNaN(radius) && radius > 0) ? radius : 15;
   }

   // Projection type from lens selection
   var projection = "rectilinear";
   if (this.equipDB) {
      var lensIdx = this.lensCombo.currentItem - 1;
      if (lensIdx >= 0 && lensIdx < this.equipDB.lenses.length) {
         projection = this.equipDB.lenses[lensIdx].projection || "rectilinear";
      }
   }
   hints._projection = projection;

   // Grid settings
   var gridPreset = this.gridPresets[this.gridCombo.currentItem];
   var gridX = gridPreset[0];
   var gridY = gridPreset[1];
   var isSplitMode = (gridX > 1 || gridY > 1);
   var overlap = parseInt(this.overlapEdit.text) || 200;

   // Log all parameters
   var imageWidth = targetWindow.mainView.image.width;
   var imageHeight = targetWindow.mainView.image.height;

   console.writeln("");
   console.writeln("========================================");
   console.writeln("Solve Parameters");
   console.writeln("========================================");
   console.writeln("  Target:      " + targetWindow.mainView.id + " (" + imageWidth + "x" + imageHeight + ")");
   console.writeln("  Camera:      " + this.cameraCombo.itemText(this.cameraCombo.currentItem));
   console.writeln("  Lens:        " + this.lensCombo.itemText(this.lensCombo.currentItem));
   console.writeln("  Projection:  " + projection);
   if (hints.scale_est) {
      console.writeln("  Scale:       " + hints.scale_est.toFixed(3) + " arcsec/px (\u00b1" + (hints.scale_err || 30) + "%)");
   } else {
      console.writeln("  Scale:       (not specified)");
   }
   if (hints.center_ra !== undefined && hints.center_dec !== undefined) {
      console.writeln("  Object:      " + this.objectEdit.text.trim());
      console.writeln("  RA:          " + raToHMS(hints.center_ra) + " (" + hints.center_ra.toFixed(4) + "\u00b0)");
      console.writeln("  DEC:         " + decToDMS(hints.center_dec) + " (" + hints.center_dec.toFixed(4) + "\u00b0)");
      console.writeln("  Radius:      " + (hints.radius || 15) + "\u00b0");
   } else {
      console.writeln("  RA/DEC:      (not specified - blind solve)");
   }
   console.writeln("  Grid:        " + gridX + "x" + gridY + (isSplitMode ? " (overlap " + overlap + "px)" : " (single)"));
   console.writeln("  SIP Order:   " + hints.tweak_order);
   if (hints.downsample_factor) {
      console.writeln("  Downsample:  " + hints.downsample_factor + "x");
   } else {
      console.writeln("  Downsample:  Auto");
   }
   console.writeln("========================================");
   console.writeln("");

   // Lock UI, show Abort button
   this._abortRequested = false;
   this.solveButton.enabled = false;
   this.solveButton.hide();
   this.abortButton.show();
   this.progressLabel.text = "Starting solve...";
   processEvents();

   try {
      if (isSplitMode) {
         this.doSplitSolve(targetWindow, apiKey, hints, gridX, gridY, overlap, imageWidth, imageHeight);
      } else {
         this.doSingleSolve(targetWindow, apiKey, hints, imageWidth, imageHeight);
      }
   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      if (errMsg.indexOf("Abort") >= 0) {
         console.writeln("Solve aborted by user.");
         this.progressLabel.text = "Aborted.";
      } else {
         console.writeln("ERROR: " + errMsg);
         this.progressLabel.text = "Error: " + errMsg;
         var msg = new MessageBox(errMsg, TITLE, StdIcon_Error, StdButton_Ok);
         msg.execute();
      }
   }

   // Restore UI
   this.abortButton.hide();
   this.solveButton.show();
   this.solveButton.enabled = true;
};

//----------------------------------------------------------------------------
// Single image solve (original Phase 1 flow)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSingleSolve = function(targetWindow, apiKey, hints, imageWidth, imageHeight) {
   // Save image to temporary FITS
   var tmpFits = File.systemTempDirectory + "/split_solver_upload.fits";
   console.writeln("Saving temporary FITS: " + tmpFits);
   this.progressLabel.text = "Saving image as FITS...";
   processEvents();

   var fmt = new FileFormat("FITS");
   var wrt = new FileFormatInstance(fmt);
   if (!wrt.create(tmpFits)) {
      this.progressLabel.text = "Error: Failed to create FITS file";
      return;
   }
   wrt.writeImage(targetWindow.mainView.image);
   wrt.close();

   var client = new AstrometryClient(apiKey);
   client.abortCheck = function() { return self._abortRequested; };

   try {
      // Login
      this.progressLabel.text = "Logging in to API...";
      processEvents();
      console.writeln("Logging in to astrometry.net...");
      if (!client.login()) {
         throw "API login failed. Please check your API key.";
      }
      console.writeln("  Login successful, session: " + client.session);

      // Upload
      this.progressLabel.text = "Uploading image...";
      processEvents();
      console.writeln("Uploading image...");
      var subId = client.upload(tmpFits, hints);
      if (subId === null) throw "Image upload failed.";
      console.writeln("  Upload successful, submission ID: " + subId);

      // Poll submission
      this.progressLabel.text = "Waiting for job assignment...";
      processEvents();
      var jobId = client.pollSubmission(subId);
      if (jobId === null) throw "Submission timed out.";
      console.writeln("  Job ID: " + jobId);

      // Poll job
      this.progressLabel.text = "Solving... (up to 5 min)";
      processEvents();
      var status = client.pollJob(jobId);
      if (status !== "success") throw "Solve failed. Try adjusting hint parameters.";
      console.writeln("  Solve successful!");

      // Get calibration
      this.progressLabel.text = "Retrieving results...";
      processEvents();
      var calibration = client.getCalibration(jobId);
      if (!calibration) throw "Failed to retrieve calibration data.";
      console.writeln("  Calibration: RA=" + calibration.ra.toFixed(4) +
                       " Dec=" + calibration.dec.toFixed(4) +
                       " scale=" + calibration.pixscale.toFixed(4) + " arcsec/px" +
                       " rotation=" + calibration.orientation.toFixed(2) + " deg");

      // Get WCS file
      var wcsPath = File.systemTempDirectory + "/split_solver_wcs.fits";
      if (!client.getWcsFile(jobId, wcsPath)) throw "Failed to download WCS file.";
      console.writeln("  WCS file downloaded: " + wcsPath);

      // Parse WCS from FITS
      this.progressLabel.text = "Applying WCS...";
      processEvents();
      var wcsData = readWcsFromFits(wcsPath);
      if (!wcsData) throw "Failed to parse WCS FITS file.";

      var wcsResult = convertToWcsResult(wcsData, imageWidth, imageHeight);
      this.applyAndDisplay(targetWindow, wcsResult, imageWidth, imageHeight, calibration);

   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      console.writeln("ERROR: " + errMsg);
      this.progressLabel.text = "Error: " + errMsg;
      var msg = new MessageBox(errMsg, TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
   }

   // Clean up
   try {
      if (File.exists(tmpFits)) File.remove(tmpFits);
      var wcsCleanPath = File.systemTempDirectory + "/split_solver_wcs.fits";
      if (File.exists(wcsCleanPath)) File.remove(wcsCleanPath);
   } catch (e) {}
};

//----------------------------------------------------------------------------
// Split image solve (Phase 2: tile splitting + multi-solve + WCS merge)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSplitSolve = function(targetWindow, apiKey, hints, gridX, gridY, overlap, imageWidth, imageHeight) {
   var self = this;
   var tiles = [];

   try {
      // 1. Split image into tiles
      this.progressLabel.text = "Splitting image into tiles... (" + gridX + "x" + gridY + ")";
      processEvents();
      console.writeln("");
      console.writeln("<b>Splitting image into " + gridX + "x" + gridY + " tiles (overlap=" + overlap + "px)</b>");

      tiles = splitImageToTiles(targetWindow, gridX, gridY, overlap);
      if (tiles.length === 0) throw "Tile splitting failed.";

      // 2. Login to astrometry.net
      this.progressLabel.text = "Logging in to API...";
      processEvents();
      var client = new AstrometryClient(apiKey);
      client.abortCheck = function() { return self._abortRequested; };
      console.writeln("Logging in to astrometry.net...");
      if (!client.login()) throw "API login failed. Please check your API key.";
      console.writeln("  Login successful");

      // 3. Solve all tiles
      console.writeln("");
      console.writeln("<b>Solving " + tiles.length + " tiles...</b>");

      var successCount = solveMultipleTiles(client, tiles, hints, imageWidth, imageHeight,
         function(message, tileIdx) {
            self.progressLabel.text = message;
            processEvents();
         }
      );

      // Print pass 1 tile grid status
      console.writeln("");
      console.writeln("<b>Pass 1 results:</b>");
      for (var row = 0; row < gridY; row++) {
         var line = "  ";
         for (var col = 0; col < gridX; col++) {
            var found = false;
            for (var t = 0; t < tiles.length; t++) {
               if (tiles[t].col === col && tiles[t].row === row) {
                  line += (tiles[t].status === "success") ? "\u25cb " : "\u00d7 ";
                  found = true;
                  break;
               }
            }
            if (!found) line += "- ";
         }
         console.writeln(line);
      }
      console.writeln("Pass 1: " + successCount + "/" + tiles.length + " tiles solved");

      // 4. Pass 2: Retry failed tiles with refined hints
      if (successCount > 0 && successCount < tiles.length) {
         this.progressLabel.text = "Pass 2: Retrying failed tiles...";
         processEvents();

         var additionalSolved = retryFailedTiles(client, tiles, hints, imageWidth, imageHeight,
            function(message, tileIdx) {
               self.progressLabel.text = message;
               processEvents();
            }
         );
         successCount += additionalSolved;

         if (additionalSolved > 0) {
            console.writeln("");
            console.writeln("<b>After pass 2:</b>");
            for (var row = 0; row < gridY; row++) {
               var line = "  ";
               for (var col = 0; col < gridX; col++) {
                  var found = false;
                  for (var t = 0; t < tiles.length; t++) {
                     if (tiles[t].col === col && tiles[t].row === row) {
                        line += (tiles[t].status === "success") ? "\u25cb " : "\u00d7 ";
                        found = true;
                        break;
                     }
                  }
                  if (!found) line += "- ";
               }
               console.writeln(line);
            }
            console.writeln("Total: " + successCount + "/" + tiles.length + " tiles solved");
         }
      }

      if (successCount < 2) {
         throw "Too few tiles solved (" + successCount + "/" + tiles.length + "). At least 2 required.";
      }

      // 5. Overlap validation
      this.progressLabel.text = "Validating overlap...";
      processEvents();

      var invalidated = validateOverlap(tiles, imageWidth, imageHeight);
      if (invalidated > 0) {
         successCount -= invalidated;
         console.writeln(invalidated + " tiles invalidated by overlap check");
         if (successCount < 2) {
            throw "Too few valid tiles after overlap validation (" + successCount + "/" + tiles.length + ").";
         }
      }

      // 6. Merge WCS solutions
      this.progressLabel.text = "Merging WCS solutions...";
      processEvents();
      console.writeln("");
      console.writeln("<b>Merging WCS solutions from " + successCount + " tiles...</b>");

      var wcsResult = mergeWcsSolutions(tiles, imageWidth, imageHeight);
      if (!wcsResult) throw "WCS merging failed.";

      // 7. Apply unified WCS
      this.applyAndDisplay(targetWindow, wcsResult, imageWidth, imageHeight, null);

      // Summary message
      var msg = new MessageBox("Split solve completed.\n\n" +
         "Tiles: " + successCount + "/" + tiles.length + " succeeded" +
         (invalidated > 0 ? " (" + invalidated + " invalidated)" : "") + "\n" +
         "RMS: " + wcsResult.rmsArcsec.toFixed(2) + " arcsec",
         TITLE, StdIcon_Information, StdButton_Ok);
      msg.execute();

   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      console.writeln("ERROR: " + errMsg);
      this.progressLabel.text = "Error: " + errMsg;
      var msg = new MessageBox(errMsg, TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
   }

   // Clean up tile temp files
   try {
      if (tiles) {
         for (var i = 0; i < tiles.length; i++) {
            if (tiles[i].filePath && File.exists(tiles[i].filePath)) {
               File.remove(tiles[i].filePath);
            }
         }
      }
   } catch (e) {}
};

//----------------------------------------------------------------------------
// Common: Apply WCS and display coordinates
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.applyAndDisplay = function(targetWindow, wcsResult, imageWidth, imageHeight, calibration) {
   console.writeln("");
   console.writeln("<b>Applying WCS to image: " + targetWindow.mainView.id + "</b>");
   console.writeln("  CRVAL = (" + wcsResult.crval1.toFixed(6) + ", " + wcsResult.crval2.toFixed(6) + ")");
   console.writeln("  CRPIX = (" + wcsResult.crpix1.toFixed(2) + ", " + wcsResult.crpix2.toFixed(2) + ")");
   console.writeln("  CD = [[" + wcsResult.cd[0][0].toExponential(6) + ", " + wcsResult.cd[0][1].toExponential(6) + "],");
   console.writeln("        [" + wcsResult.cd[1][0].toExponential(6) + ", " + wcsResult.cd[1][1].toExponential(6) + "]]");
   if (wcsResult.sip) {
      console.writeln("  SIP order: " + wcsResult.sip.order);
   }
   if (wcsResult.rmsArcsec !== undefined) {
      console.writeln("  RMS residual: " + wcsResult.rmsArcsec.toFixed(2) + " arcsec");
   }

   // Apply WCS
   targetWindow.mainView.beginProcess(UndoFlag_Keywords);
   applyWCSToImage(targetWindow, wcsResult, imageWidth, imageHeight);
   setCustomControlPoints(targetWindow, wcsResult, [], imageWidth, imageHeight, "off");
   targetWindow.mainView.endProcess();

   // Display coordinates
   var wcsObj = {
      crval1: wcsResult.crval1, crval2: wcsResult.crval2,
      crpix1: wcsResult.crpix1, crpix2: wcsResult.crpix2,
      cd1_1: wcsResult.cd[0][0], cd1_2: wcsResult.cd[0][1],
      cd2_1: wcsResult.cd[1][0], cd2_2: wcsResult.cd[1][1],
      sip: wcsResult.sip
   };
   displayImageCoordinates(wcsObj, imageWidth, imageHeight);

   this.progressLabel.text = "Solve completed!";
   console.writeln("");
   console.writeln("<b>Solve completed successfully!</b>");

   if (calibration) {
      var msg = new MessageBox("Solve completed.\n\n" +
         "RA: " + raToHMS(calibration.ra) + "\n" +
         "DEC: " + decToDMS(calibration.dec) + "\n" +
         "Scale: " + calibration.pixscale.toFixed(4) + " arcsec/px\n" +
         "Rotation: " + calibration.orientation.toFixed(2) + " deg",
         TITLE, StdIcon_Information, StdButton_Ok);
      msg.execute();
   }
};

//============================================================================
// Main entry point
//============================================================================

function main() {
   console.show();
   console.writeln("<b>" + TITLE + " v" + VERSION + "</b>");
   console.writeln("---");

   var dialog = new SplitSolverDialog();
   dialog.execute();
}

main();
