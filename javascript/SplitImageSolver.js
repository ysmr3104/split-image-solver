#feature-id    SplitImageSolver : Astrometry > SplitImageSolver
#feature-info  Automatic plate solver using astrometry.net API or local solve-field: \
   single-image or split-tile solve with WCS application for PixInsight.

//----------------------------------------------------------------------------
// SplitImageSolver.js - PixInsight JavaScript Runtime (PJSR) Script
//
// Automatic plate solver using astrometry.net API.
// Single-image solve with WCS application.
//
// Copyright (c) 2026 Split Image Solver Project
//----------------------------------------------------------------------------

#define VERSION "1.0.0"
#define VERSION_SUFFIX ""

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
#include <pjsr/StdCursor.jsh>

#include "wcs_math.js"
#include "wcs_keywords.js"
#include "astrometry_api.js"
#include "equipment_data.jsh"

#define TITLE "Split Image Solver"

// ImageSolver library integration (PixInsight built-in solver)
// This enables using PixInsight's ImageSolver engine instead of astrometry.net.
// Requires PixInsight 1.9.0+ with ImageSolver 6.x installed.
// To disable: comment out the #define line below.
#define ENABLE_IMAGESOLVER

#ifdef ENABLE_IMAGESOLVER
#include "imagesolver_bridge.jsh"
#endif

// Equipment data is loaded via #include "equipment_data.jsh" (sets __equipmentData__)

//============================================================================
// Ported utility functions from ManualImageSolver.js
//============================================================================

// Quote a file path for shell execution (handles spaces and special characters)
function quotePath(path) {
   return "'" + path.replace(/'/g, "'\\''") + "'";
}

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

// pixelToRaDec for astrometry.net WCS (top-down FITS convention)
// PixInsight saves FITS top-first, so astrometry.net returns CRPIX in
// top-down convention: FITS y=1 at image top, v = (py + 1) - crpix2
function pixelToRaDecTD(wcs, px, py) {
   var u = (px + 1.0) - wcs.crpix1;
   var v = (py + 1.0) - wcs.crpix2;
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

   // Write PCL:AstrometricSolution properties required by SPFC and other tools.
   // regenerateAstrometricSolution() rebuilds the internal solution from keywords,
   // but some tools (e.g. SPFC) check these properties directly.
   var view = targetWindow.mainView;
   var attrs = PropertyAttribute_Storable | PropertyAttribute_Permanent;

   // Remove any existing SplineWorldTransformation properties from previous solutions.
   // If left behind, regenerateAstrometricSolution() tries to rebuild the spline
   // and fails with "Invalid length(s) of surface spline coefficient vector(s)".
   var existingProps = view.properties;
   for (var pi = 0; pi < existingProps.length; pi++) {
      if (existingProps[pi].indexOf("SplineWorldTransformation") >= 0) {
         view.deleteProperty(existingProps[pi]);
      }
   }
   // Also remove the legacy property
   view.deleteProperty("Transformation_ImageToProjection");
   // Remove previous solution information
   view.deleteProperty("PCL:AstrometricSolution:Information");

   // Projection system (TAN = Gnomonic)
   view.setPropertyValue("PCL:AstrometricSolution:ProjectionSystem", "Gnomonic", PropertyType_String8, attrs);

   // Reference celestial coordinates (projection origin in degrees)
   var refCelestial = new Vector([wcsResult.crval1, wcsResult.crval2]);
   view.setPropertyValue("PCL:AstrometricSolution:ReferenceCelestialCoordinates", refCelestial, PropertyType_F64Vector, attrs);

   // Reference image coordinates (I-coordinates: 0-based x, bottom-up y)
   // Convert from our FITS BU convention (1-based) to I-coordinates (0-based)
   var refImgX = wcsResult.crpix1 - 1;
   var refImgY = wcsResult.crpix2;  // Already bottom-up in our convention
   var refImage = new Vector([refImgX, refImgY]);
   view.setPropertyValue("PCL:AstrometricSolution:ReferenceImageCoordinates", refImage, PropertyType_F64Vector, attrs);

   // Linear transformation matrix (2x2, I-coordinates to gnomonic native coordinates)
   // In I-coordinates (0-based x, bottom-up y), CD matrix maps directly
   var ltMatrix = new Matrix(2, 2);
   ltMatrix.at(0, 0, wcsResult.cd[0][0]);
   ltMatrix.at(0, 1, wcsResult.cd[0][1]);
   ltMatrix.at(1, 0, wcsResult.cd[1][0]);
   ltMatrix.at(1, 1, wcsResult.cd[1][1]);
   view.setPropertyValue("PCL:AstrometricSolution:LinearTransformationMatrix", ltMatrix, PropertyType_F64Matrix, attrs);

   // Native coordinates of the reference point (standard for TAN: 0, 90)
   var refNative = new Vector([0, 90]);
   view.setPropertyValue("PCL:AstrometricSolution:ReferenceNativeCoordinates", refNative, PropertyType_F64Vector, attrs);

   // Celestial pole native coordinates
   var plon = (wcsResult.crval2 < 90) ? 180 : 0;
   var plat = 90;
   var celestialPole = new Vector([plon, plat]);
   view.setPropertyValue("PCL:AstrometricSolution:CelestialPoleNativeCoordinates", celestialPole, PropertyType_F64Vector, attrs);

   // Observation center coordinates
   view.setPropertyValue("Observation:Center:RA", imgCenter[0], PropertyType_Float64, attrs);
   view.setPropertyValue("Observation:Center:Dec", imgCenter[1], PropertyType_Float64, attrs);
   view.setPropertyValue("Observation:CelestialReferenceSystem", "ICRS", PropertyType_String8, attrs);
   view.setPropertyValue("Observation:Equinox", 2000.0, PropertyType_Float64, attrs);

   // Creation metadata
   view.setPropertyValue("PCL:AstrometricSolution:CreationTime", (new Date).toISOString(), PropertyType_TimePoint, attrs);
   var creatorApp = format("PixInsight %s%d.%d.%d",
      CoreApplication.versionLE ? "LE " : "",
      CoreApplication.versionMajor,
      CoreApplication.versionMinor,
      CoreApplication.versionRelease);
   view.setPropertyValue("PCL:AstrometricSolution:CreatorApplication", creatorApp, PropertyType_String, attrs);
   view.setPropertyValue("PCL:AstrometricSolution:CreatorModule", "SplitImageSolver " + VERSION, PropertyType_String, attrs);

   // NOTE: Do NOT call regenerateAstrometricSolution() here.
   // It must be called AFTER setCustomControlPoints() writes spline control points,
   // otherwise the spline coefficients will be inconsistent with the control points.
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
   // Convert astrometry.net WCS from top-down to bottom-up (FITS standard) convention.
   // PixInsight saves FITS top-first, so astrometry.net CRPIX uses top-down.
   // WCSFitter/applyWCSToImage/displayImageCoordinates expect bottom-up.
   // Conversion: CRPIX2_BU = imageHeight + 1 - CRPIX2_TD, negate CD/SIP v-components.
   var crpix2BU = imageHeight + 1 - wcs.crpix2;

   var result = {
      crval1: wcs.crval1,
      crval2: wcs.crval2,
      crpix1: wcs.crpix1,
      crpix2: crpix2BU,
      cd: [[wcs.cd1_1 || 0, -(wcs.cd1_2 || 0)], [wcs.cd2_1 || 0, -(wcs.cd2_2 || 0)]],
      sip: null,
      sipMode: null
   };

   // SIP coefficients conversion (negate terms with odd v-power)
   if (wcs.sipCoeffs && wcs.aOrder) {
      var flipV = function(coeffs) {
         if (!coeffs) return coeffs;
         var flipped = [];
         for (var k = 0; k < coeffs.length; k++) {
            var p = coeffs[k][0], q = coeffs[k][1], c = coeffs[k][2];
            flipped.push([p, q, (q % 2 === 1) ? -c : c]);
         }
         return flipped;
      };
      result.sip = {
         order: wcs.aOrder,
         a: flipV(wcs.sipCoeffs.a || []),
         b: flipV(wcs.sipCoeffs.b || []),
         ap: flipV(wcs.sipCoeffs.ap || null),
         bp: flipV(wcs.sipCoeffs.bp || null),
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
// skipEdges: { top, bottom, left, right } edge tile rows/cols to skip
// Returns array of tile objects:
//   { filePath, col, row, offsetX, offsetY, tileWidth, tileHeight,
//     scaleFactor, origOffsetX, origOffsetY, origTileWidth, origTileHeight }
//----------------------------------------------------------------------------
function splitImageToTiles(targetWindow, gridX, gridY, overlap, skipEdges) {
   var image = targetWindow.mainView.image;
   var imgW = image.width;
   var imgH = image.height;

   // Edge skip: number of tile rows/cols to skip from each edge
   var skipTop = (skipEdges && skipEdges.top) || 0;
   var skipBottom = (skipEdges && skipEdges.bottom) || 0;
   var skipLeft = (skipEdges && skipEdges.left) || 0;
   var skipRight = (skipEdges && skipEdges.right) || 0;

   // Compute tile sizes (before overlap)
   var baseTileW = Math.floor(imgW / gridX);
   var baseTileH = Math.floor(imgH / gridY);

   var tiles = [];
   var tmpDir = File.systemTempDirectory;

   for (var row = 0; row < gridY; row++) {
      for (var col = 0; col < gridX; col++) {
         // Skip edge tiles
         if (row < skipTop || row >= gridY - skipBottom ||
             col < skipLeft || col >= gridX - skipRight) {
            console.writeln("  Tile [" + col + "," + row + "] skipped (edge exclusion)");
            continue;
         }
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

         // Create a new ImageWindow for the tile (32-bit float for precision)
         // Stretch calculations run in float; final uint16 conversion at FITS save time
         var tileWin = new ImageWindow(tileW, tileH,
            image.numberOfChannels, 32,
            true, image.isColor,
            "tile_" + col + "_" + row);

         // Copy pixel data from source using selectedRect
         tileWin.mainView.beginProcess(UndoFlag_NoSwapFile);
         image.selectedRect = new Rect(x0, y0, x1, y1);
         tileWin.mainView.image.apply(image, ImageOp_Mov);
         image.resetSelections();
         tileWin.mainView.endProcess();

         // Convert to grayscale (luminance) for better source extraction
         // (matching Python: 0.2126*R + 0.7152*G + 0.0722*B)
         if (tileWin.mainView.image.isColor) {
            var convToGray = new ConvertToGrayscale;
            convToGray.executeOn(tileWin.mainView);
         }

         // Percentile stretch for better star detection by astrometry.net
         // (matching Python: clip to percentile(0.5)-percentile(99.9), scale to 0-1)
         // Build histogram by sampling pixels (every 4th pixel for speed)
         var tileImg = tileWin.mainView.image;
         var histSize = 65536;
         var hist = new Array(histSize);
         for (var hi = 0; hi < histSize; hi++) hist[hi] = 0;
         var totalSamples = 0;
         for (var sy = 0; sy < tileImg.height; sy += 4) {
            for (var sx = 0; sx < tileImg.width; sx += 4) {
               var sv = tileImg.sample(sx, sy);
               var bin = Math.round(sv * (histSize - 1));
               if (bin < 0) bin = 0;
               if (bin >= histSize) bin = histSize - 1;
               hist[bin]++;
               totalSamples++;
            }
         }
         // Compute percentile from histogram
         var computePercentile = function(histogram, total, pct) {
            var target = total * pct / 100.0;
            var cumul = 0;
            for (var pi = 0; pi < histogram.length; pi++) {
               cumul += histogram[pi];
               if (cumul >= target) return pi / (histogram.length - 1.0);
            }
            return 1.0;
         };
         var vmin = computePercentile(hist, totalSamples, 0.5);
         var vmax = computePercentile(hist, totalSamples, 99.9);
         if (vmax <= vmin) vmax = vmin + 0.001;
         console.writeln("  Tile [" + col + "," + row + "] stretch: vmin=" +
            vmin.toFixed(6) + " vmax=" + vmax.toFixed(6));
         tileWin.mainView.beginProcess(UndoFlag_NoSwapFile);
         // Rescale: (pixel - vmin) / (vmax - vmin), clipped to [0, 1]
         tileImg.apply(vmin, ImageOp_Sub);
         tileImg.apply(1.0 / (vmax - vmin), ImageOp_Mul);
         tileImg.truncate(0, 1);
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

         // Convert float32 to uint16 for FITS output
         var currentW = tileWin.mainView.image.width;
         var currentH = tileWin.mainView.image.height;
         var outWin = new ImageWindow(currentW, currentH, 1, 16, false, false, "out_tile");
         outWin.mainView.beginProcess(UndoFlag_NoSwapFile);
         outWin.mainView.image.apply(tileWin.mainView.image, ImageOp_Mov);
         outWin.mainView.endProcess();
         tileWin.forceClose();

         // Save to FITS using FileFormatInstance
         var fitsPath = tmpDir + "/split_tile_" + col + "_" + row + ".fits";
         var fmt = new FileFormat("FITS");
         var wrt = new FileFormatInstance(fmt);
         if (wrt.create(fitsPath)) {
            wrt.writeImage(outWin.mainView.image);
            wrt.close();
         }
         // Log tile file info
         var fInfo = new FileInfo(fitsPath);
         console.writeln("  Tile [" + col + "," + row + "] saved: " +
            outWin.mainView.image.width + "x" + outWin.mainView.image.height +
            " ch=" + outWin.mainView.image.numberOfChannels +
            " bits=" + outWin.mainView.image.bitsPerSample +
            " size=" + Math.round(fInfo.size / 1024) + "KB");

         outWin.forceClose();

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
// printTileGrid - print current tile status as a grid
//
// tiles: array of tile objects with .col, .row, .status
// gridX, gridY: grid dimensions
//----------------------------------------------------------------------------
function printTileGrid(tiles, gridX, gridY) {
   // Build tile lookup for O(1) access
   var tileMap = {};
   for (var t = 0; t < tiles.length; t++) {
      tileMap[tiles[t].col + "," + tiles[t].row] = tiles[t];
   }

   // Column header
   var header = "    ";
   for (var c = 0; c < gridX; c++) {
      header += c + " ";
   }
   console.writeln(header);

   for (var row = 0; row < gridY; row++) {
      var line = (row < 10 ? " " : "") + row + "  ";
      for (var col = 0; col < gridX; col++) {
         var tile = tileMap[col + "," + row];
         if (!tile) {
            line += "  "; // skip edge excluded
         } else if (tile.status === "success") {
            line += "\u25cb ";
         } else if (tile.status === "skipped") {
            line += "\u2014 ";
         } else if (tile.status === "failed") {
            line += "\u00d7 ";
         } else {
            line += "\u00b7 "; // pending
         }
      }
      console.writeln(line);
   }
}

//----------------------------------------------------------------------------
// ImageSolver integration: WCS extraction and conversion utilities
//----------------------------------------------------------------------------

// Extract WCS keywords from a solved PixInsight ImageWindow
// Returns object with crval1/2, crpix1/2, cd1_1/1_2/2_1/2_2 or null
function extractWcsFromWindow(window) {
   var keywords = window.keywords;
   var wcs = {};
   for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      var name = kw.name.trim();
      var valStr = kw.value.trim().replace(/^'|'$/g, "").trim();
      switch (name) {
         case "CRVAL1": wcs.crval1 = parseFloat(valStr); break;
         case "CRVAL2": wcs.crval2 = parseFloat(valStr); break;
         case "CRPIX1": wcs.crpix1 = parseFloat(valStr); break;
         case "CRPIX2": wcs.crpix2 = parseFloat(valStr); break;
         case "CD1_1":  wcs.cd1_1 = parseFloat(valStr); break;
         case "CD1_2":  wcs.cd1_2 = parseFloat(valStr); break;
         case "CD2_1":  wcs.cd2_1 = parseFloat(valStr); break;
         case "CD2_2":  wcs.cd2_2 = parseFloat(valStr); break;
      }
   }
   if (wcs.crval1 === undefined || wcs.crval2 === undefined) return null;
   return wcs;
}

// Extract WCS values directly from ImageSolver's metadata object.
// Uses metadata.GetWCSvalues() which returns CRPIX/CD in FITS F-coordinates.
// This is more reliable than reading FITS keywords back from the window,
// as SaveKeywords may not have flushed to window.keywords yet.
function extractWcsFromMetadata(metadata) {
   try {
      var wcs = metadata.GetWCSvalues();
      return {
         crval1: wcs.crval1,
         crval2: wcs.crval2,
         crpix1: wcs.crpix1,
         crpix2: wcs.crpix2,
         cd1_1:  wcs.cd1_1,
         cd1_2:  wcs.cd1_2,
         cd2_1:  wcs.cd2_1,
         cd2_2:  wcs.cd2_2
      };
   } catch (e) {
      console.writeln("ERROR: extractWcsFromMetadata failed: " + e.toString());
      return null;
   }
}

// Convert ImageSolver WCS (FITS F-coordinates, bottom-up) to top-down convention
// used by astrometry.net / our tile pipeline (pixelToRaDecTD).
//
// ImageSolver uses FITS standard: F_x = I_x - 0.5, F_y = -I_y + height + 0.5
// where CRPIX is in F coordinates (0-based x, bottom-up y).
// Our TD convention: CRPIX is 1-based from top.
//
// Conversion:
//   crpix1_TD = crpix1_IS + 1
//   crpix2_TD = tileHeight + 1 - crpix2_IS
//   cd1_2_TD  = -cd1_2_IS  (y-axis flip)
//   cd2_2_TD  = -cd2_2_IS  (y-axis flip)
function convertISwcsToTD(isWcs, tileHeight) {
   return {
      crval1: isWcs.crval1,
      crval2: isWcs.crval2,
      crpix1: isWcs.crpix1 + 1,
      crpix2: tileHeight + 1 - isWcs.crpix2,
      cd1_1:  isWcs.cd1_1,
      cd1_2:  -(isWcs.cd1_2 || 0),
      cd2_1:  isWcs.cd2_1,
      cd2_2:  -(isWcs.cd2_2 || 0)
   };
}

// Convert ImageSolver WCS to bottom-up convention for single-solve wcsResult.
// Used by applyAndDisplay / pixelToRaDec.
//
// Conversion:
//   crpix1_BU = crpix1_IS + 1
//   crpix2_BU = crpix2_IS  (no change - both are bottom-up)
//   CD matrix: unchanged
function convertISwcsToBU(isWcs) {
   return {
      crval1: isWcs.crval1,
      crval2: isWcs.crval2,
      crpix1: isWcs.crpix1 + 1,
      crpix2: isWcs.crpix2,
      cd: [[isWcs.cd1_1 || 0, isWcs.cd1_2 || 0],
           [isWcs.cd2_1 || 0, isWcs.cd2_2 || 0]],
      sip: null,
      sipMode: null
   };
}

//----------------------------------------------------------------------------
// Solve a single tile using ImageSolver (PixInsight built-in solver).
// Same interface as solveSingleTile but uses ImageSolver instead of astrometry.net.
//
// tile: tile object (modified in place: .wcs, .calibration, .status)
// tileHints: hint parameters (center_ra, center_dec, scale_lower/upper)
// medianScale: for false positive filter (0 to skip)
// expectedRaDec: [ra, dec] for false positive filter (null to skip)
//----------------------------------------------------------------------------
function solveSingleTileIS(tile, tileHints, medianScale, expectedRaDec) {
   tile.status = "solving";

   // Open tile FITS as ImageWindow
   var tileWindows;
   try {
      tileWindows = ImageWindow.open(tile.filePath);
   } catch (e) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] failed to open: " + e.toString());
      return false;
   }
   if (!tileWindows || tileWindows.length === 0) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] failed to open image");
      return false;
   }
   var tileWindow = tileWindows[0];
   var tileActualHeight = tileWindow.mainView.image.height;

   try {
      // Create and configure ImageSolver
      var solver = new ImageSolver();
      solver.Init(tileWindow, true); // prioritize settings over image metadata

      // Override metadata with our tile hints
      if (tileHints.center_ra !== undefined) {
         solver.metadata.ra = tileHints.center_ra;
      }
      if (tileHints.center_dec !== undefined) {
         solver.metadata.dec = tileHints.center_dec;
      }

      // Set resolution (arcsec/px -> degrees/px for ImageSolver)
      var scaleArcsec;
      if (tileHints.scale_lower && tileHints.scale_upper) {
         scaleArcsec = (tileHints.scale_lower + tileHints.scale_upper) / 2.0;
      } else if (tileHints.scale_est) {
         scaleArcsec = tileHints.scale_est;
      }
      if (scaleArcsec) {
         solver.metadata.resolution = scaleArcsec / 3600.0; // arcsec -> degrees
      }

      // Ensure image dimensions are set
      solver.metadata.width = tileWindow.mainView.image.width;
      solver.metadata.height = tileWindow.mainView.image.height;

      // Configure solver: suppress output images, disable distortion correction for tiles
      solver.solverCfg.showStars = false;
      solver.solverCfg.showStarMatches = false;
      solver.solverCfg.showDistortion = false;
      solver.solverCfg.showSimplifiedSurfaces = false;
      solver.solverCfg.generateErrorImg = false;
      solver.solverCfg.generateDistortModel = false;
      solver.solverCfg.distortionCorrection = false; // linear WCS only for tiles

      // Solve
      if (!solver.SolveImage(tileWindow)) {
         tile.status = "failed";
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] ImageSolver failed");
         tileWindow.forceClose();
         return false;
      }

      // Extract WCS directly from solver metadata (more reliable than reading keywords back)
      var isWcs = extractWcsFromMetadata(solver.metadata);
      tileWindow.forceClose();

      if (!isWcs || isWcs.crval1 === undefined) {
         tile.status = "failed";
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] WCS extraction failed");
         return false;
      }

      // Convert to top-down convention (compatible with our pipeline)
      var wcsData = convertISwcsToTD(isWcs, tileActualHeight);

      // Get resolution from solver metadata (arcsec/px)
      var resolvedScale = solver.metadata.resolution ? solver.metadata.resolution * 3600.0 : 0;

      // Create calibration-like object for compatibility
      var calibration = {
         ra: isWcs.crval1,
         dec: isWcs.crval2,
         pixscale: resolvedScale,
         orientation: 0 // computed from CD matrix if needed
      };

      // Compute orientation from CD matrix
      if (isWcs.cd1_2 !== undefined && isWcs.cd2_2 !== undefined) {
         calibration.orientation = Math.atan2(isWcs.cd2_1 || 0, isWcs.cd2_2 || 0) * 180.0 / Math.PI;
      }

      // False positive filter: scale ratio
      if (medianScale > 0 && calibration.pixscale > 0) {
         var scaleRatio = calibration.pixscale / medianScale;
         if (scaleRatio < 0.3 || scaleRatio > 3.0) {
            tile.status = "failed";
            console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] rejected: scale ratio " + scaleRatio.toFixed(2));
            return false;
         }
      }

      // False positive filter: coordinate deviation
      if (expectedRaDec) {
         var coordDev = angularSeparation(expectedRaDec, [calibration.ra, calibration.dec]);
         if (coordDev > 5.0) {
            tile.status = "failed";
            console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] rejected: coord deviation " + coordDev.toFixed(2) + " deg");
            return false;
         }
      }

      // CRPIX reverse transform: undo downsampling
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

      // Apply tile offset (top-down convention, same as astrometry.net mode)
      wcsData.crpix1 += tile.offsetX;
      wcsData.crpix2 += tile.offsetY;

      tile.wcs = wcsData;
      tile.calibration = calibration;
      tile.status = "success";

      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] solved (ImageSolver): RA=" +
         calibration.ra.toFixed(4) + " Dec=" + calibration.dec.toFixed(4) +
         " scale=" + calibration.pixscale.toFixed(3) + " arcsec/px");
      return true;

   } catch (e) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] error: " + e.toString());
      try { tileWindow.forceClose(); } catch (ex) {}
      return false;
   }
}

//----------------------------------------------------------------------------
// Solve a single tile. Returns true if solved successfully.
// tile: tile object (modified in place: .wcs, .calibration, .status)
// tileHints: hint parameters for this tile
// client: AstrometryClient
// medianScale: for false positive filter (0 to skip)
// expectedRaDec: [ra, dec] for false positive filter (null to skip)
function solveSingleTile(client, tile, tileHints, medianScale, expectedRaDec) {
   tile.status = "solving";

   // Upload
   var subId = client.upload(tile.filePath, tileHints);
   if (subId === null) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] upload failed");
      return false;
   }

   // Poll submission
   var jobId = client.pollSubmission(subId);
   if (jobId === null) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] submission timed out");
      return false;
   }

   // Poll job
   var status = client.pollJob(jobId);
   if (status !== "success") {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] solve failed");
      return false;
   }

   // Get calibration + WCS
   var calibration = client.getCalibration(jobId);
   var wcsPath = File.systemTempDirectory + "/split_wcs_" + tile.col + "_" + tile.row + ".fits";
   var wcsOk = client.getWcsFile(jobId, wcsPath);

   if (!calibration || !wcsOk) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] result retrieval failed");
      try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}
      return false;
   }

   // Parse WCS
   var wcsData = readWcsFromFits(wcsPath);
   try { if (File.exists(wcsPath)) File.remove(wcsPath); } catch (e) {}
   if (!wcsData || wcsData.crval1 === undefined) {
      tile.status = "failed";
      console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] WCS parse failed");
      return false;
   }

   // False positive filter: scale ratio
   if (medianScale > 0 && calibration.pixscale) {
      var scaleRatio = calibration.pixscale / medianScale;
      if (scaleRatio < 0.3 || scaleRatio > 3.0) {
         tile.status = "failed";
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] rejected: scale ratio " + scaleRatio.toFixed(2));
         return false;
      }
   }

   // False positive filter: coordinate deviation
   if (expectedRaDec) {
      var coordDev = angularSeparation(expectedRaDec, [calibration.ra, calibration.dec]);
      if (coordDev > 5.0) {
         tile.status = "failed";
         console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] rejected: coord deviation " + coordDev.toFixed(2) + " deg");
         return false;
      }
   }

   // CRPIX reverse transform: undo downsampling
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

   // Apply tile offset (top-down convention, same as Python)
   wcsData.crpix1 += tile.offsetX;
   wcsData.crpix2 += tile.offsetY;

   tile.wcs = wcsData;
   tile.calibration = calibration;
   tile.status = "success";

   console.writeln("  [" + timestamp() + "] Tile [" + tile.col + "," + tile.row + "] solved: RA=" +
      calibration.ra.toFixed(4) + " Dec=" + calibration.dec.toFixed(4) +
      " scale=" + calibration.pixscale.toFixed(3) + " arcsec/px");
   return true;
}

//----------------------------------------------------------------------------
// solveWavefront
//
// Wavefront (ripple) tile solving: start from center, expand outward.
// Each solved tile provides precise hints for its unsolved neighbors.
// This replaces the old 2-pass approach (solveMultipleTiles + retryFailedTiles).
//
// Returns number of successfully solved tiles.
//----------------------------------------------------------------------------
function solveWavefront(client, tiles, hints, imageWidth, imageHeight, gridX, gridY, progressCallback, tileSolverFn, abortCheckFn, skipCheckFn, rateLimitMs) {
   var notify = progressCallback || function() {};
   var successCount = 0;
   var attemptCount = 0;
   var startTime = (new Date()).getTime();

   // Build tile grid lookup: tileGrid[col][row] = tile
   var tileGrid = {};
   for (var i = 0; i < tiles.length; i++) {
      var key = tiles[i].col + "," + tiles[i].row;
      tileGrid[key] = tiles[i];
   }

   // Helper: get tile by col,row
   var getTile = function(col, row) {
      return tileGrid[col + "," + row] || null;
   };

   // Helper: get 4-connected neighbors
   var getNeighbors = function(tile) {
      var neighbors = [];
      var dirs = [[0,-1],[0,1],[-1,0],[1,0]]; // up,down,left,right
      for (var d = 0; d < dirs.length; d++) {
         var nb = getTile(tile.col + dirs[d][0], tile.row + dirs[d][1]);
         if (nb) neighbors.push(nb);
      }
      return neighbors;
   };

   // Helper: compute refined scale from solved tiles
   var computeRefinedHints = function(solvedTiles) {
      var scales = [];
      for (var k = 0; k < solvedTiles.length; k++) {
         if (solvedTiles[k].calibration) scales.push(solvedTiles[k].calibration.pixscale);
      }
      scales.sort(function(a, b) { return a - b; });
      var medianScale = scales.length > 0 ? scales[Math.floor(scales.length / 2)] : 0;
      return { medianScale: medianScale };
   };

   // Helper: build hint object for API
   //
   // Apply projection scale correction (matching Python's _effective_pixel_scale_factor)
   // so the API receives the correct effective arcsec/px for each tile position.
   // Also compute dynamic scale_err margin based on distance from image center.
   var buildTileHints = function(tile, baseHints) {
      var tileHints = {};
      for (var key in baseHints) {
         if (baseHints.hasOwnProperty(key)) tileHints[key] = baseHints[key];
      }

      // Always use per-tile precomputed hints for center_ra/center_dec
      if (tile.hintRA !== undefined && tile.hintDEC !== undefined) {
         tileHints.center_ra = tile.hintRA;
         tileHints.center_dec = tile.hintDEC;
      }

      // Projection scale correction (Python equivalent)
      // Use native optical scale for projection geometry (not resampled scale).
      // Resampling changes pixel size but not the angular geometry of the lens.
      var nativeScale = baseHints._nativeScale || baseHints.scale_est;
      var baseScaleArcsec = baseHints.scale_est;
      var projection = baseHints._projection || "rectilinear";

      if (baseScaleArcsec) {
         var tileCX = tile.offsetX + tile.tileWidth / 2.0;
         var tileCY = tile.offsetY + tile.tileHeight / 2.0;
         var imgCX = imageWidth / 2.0;
         var imgCY = imageHeight / 2.0;

         // Use native scale for angular distance calculation
         var scaleRad = (nativeScale / 3600.0) * Math.PI / 180.0;
         var rPixels = Math.sqrt(
            (tileCX - imgCX) * (tileCX - imgCX) + (tileCY - imgCY) * (tileCY - imgCY)
         );

         // Angular distance from center (depends on projection type)
         var rScaled = rPixels * scaleRad;
         var theta;
         switch (projection) {
            case "equisolid":    theta = 2 * Math.asin(Math.min(rScaled / 2, 1)); break;
            case "equidistant":  theta = rScaled; break;
            case "stereographic": theta = 2 * Math.atan(rScaled / 2); break;
            default:             theta = Math.atan(rScaled); break; // rectilinear (gnomonic)
         }

         // Effective pixel scale factor (Python: _effective_pixel_scale_factor)
         var factor = 1.0;
         if (theta > 0.001) {
            switch (projection) {
               case "rectilinear":
                  var cosT = Math.cos(theta);
                  factor = 1.0 / (cosT * cosT);
                  break;
               case "equisolid":
                  factor = Math.sqrt(1.0 - Math.sin(theta / 2.0) * Math.sin(theta / 2.0)) /
                           Math.cos(theta);
                  break;
               case "equidistant":
                  factor = theta / Math.sin(theta);
                  break;
               case "stereographic":
                  var cosHalf = Math.cos(theta / 2.0);
                  factor = 1.0 / (cosHalf * cosHalf * Math.cos(theta));
                  break;
            }
         }

         // Apply projection factor to native scale (matching Python behavior).
         // Python computes effective_scale from native sensor scale, not resampled.
         // The tile image pixels correspond to the native optical geometry.
         var effectiveScale = nativeScale * factor;

         // Dynamic margin: Python's 0.2 + 0.3 * (r / max_r)
         var maxR = Math.sqrt(imgCX * imgCX + imgCY * imgCY);
         var rRatio = maxR > 0 ? rPixels / maxR : 0;
         var margin = 0.2 + 0.3 * rRatio;

         // Downsample scale adjustment
         if (tile.scaleFactor < 1.0) {
            effectiveScale = effectiveScale / tile.scaleFactor;
         }

         // Use scale_lower/scale_upper (matching Python's solve-field --scale-low/--scale-high)
         tileHints.scale_lower = effectiveScale * (1.0 - margin);
         tileHints.scale_upper = effectiveScale * (1.0 + margin);
         // Remove scale_est/scale_err to avoid conflict
         delete tileHints.scale_est;
         delete tileHints.scale_err;
      }

      delete tileHints._projection;
      delete tileHints._nativeScale;
      return tileHints;
   };

   // --- Wavefront algorithm ---

   // Wave 0: center tile (first in spiral order, already sorted center-first)
   var queue = [tiles[0]];
   var queued = {}; // track which tiles are in queue/done
   queued[tiles[0].col + "," + tiles[0].row] = true;

   var wave = 0;
   var solvedTiles = [];

   while (queue.length > 0) {
      wave++;
      var currentWave = queue.slice(); // copy current wave
      queue = []; // next wave will be built as tiles solve

      console.writeln("");
      console.writeln("<b>Wave " + wave + ": " + currentWave.length + " tile(s)</b>");

      for (var wi = 0; wi < currentWave.length; wi++) {
         // Check for abort (works for all modes including ImageSolver where client is null)
         processEvents();
         if (console.abortRequested ||
             (client && typeof client.abortCheck === "function" && client.abortCheck()) ||
             (typeof abortCheckFn === "function" && abortCheckFn())) {
            throw "Aborted by user";
         }
         if ((client && typeof client.skipCheck === "function" && client.skipCheck()) ||
             (typeof skipCheckFn === "function" && skipCheckFn())) {
            console.writeln("  [" + timestamp() + "] Skipping remaining tiles (user requested)");
            for (var rem = wi; rem < currentWave.length; rem++) {
               currentWave[rem].status = "skipped";
            }
            return successCount;
         }

         var tile = currentWave[wi];
         attemptCount++;
         var elapsed = (new Date()).getTime() - startTime;
         var prefix = "[" + timestamp() + "] [" + attemptCount + "/" + tiles.length + "] Tile [" + tile.col + "," + tile.row + "]";
         notify(prefix + " (wave " + wave + ") solving... | " + formatElapsed(elapsed) + " elapsed | " + successCount + " solved", wi);
         // Build hints: per-tile effective scale with projection correction
         var refinedInfo = (solvedTiles.length > 0) ? computeRefinedHints(solvedTiles) : null;
         var tileHints = buildTileHints(tile, hints);
         var medianScale = refinedInfo ? refinedInfo.medianScale : 0;

         // Refine RA/DEC hints using nearest solved tile's WCS (Python 2nd pass equivalent)
         // Only use WCS extrapolation when the target point falls within or near
         // the solved tile's coverage area. TAN projection breaks down at large distances.
         var expectedRaDec = null;
         if (solvedTiles.length > 0) {
            var tileCX = tile.offsetX + tile.tileWidth / 2.0;
            var tileCY = tile.offsetY + tile.tileHeight / 2.0;
            var nearestDist2 = Infinity;
            var nearestTile = null;
            for (var si = 0; si < solvedTiles.length; si++) {
               var st = solvedTiles[si];
               var stCX = st.offsetX + st.tileWidth / 2.0;
               var stCY = st.offsetY + st.tileHeight / 2.0;
               var d2 = (tileCX - stCX) * (tileCX - stCX) + (tileCY - stCY) * (tileCY - stCY);
               if (d2 < nearestDist2) {
                  nearestDist2 = d2;
                  nearestTile = st;
               }
            }
            if (nearestTile && nearestTile.wcs) {
               // Extrapolate RA/DEC from nearest solved tile's WCS (Python 2nd pass equivalent)
               // Python does this without distance limit, using nearest solved tile regardless of distance
               var refined = pixelToRaDecTD(nearestTile.wcs, tileCX, tileCY);
               if (refined && isFinite(refined[0]) && isFinite(refined[1])) {
                  var distPx = Math.sqrt(nearestDist2);
                  tileHints.center_ra = refined[0];
                  tileHints.center_dec = refined[1];
                  // Widen scale range for WCS-extrapolated hints (Python 2nd pass: ±50%)
                  if (tileHints.scale_lower && tileHints.scale_upper) {
                     var midScale = (tileHints.scale_lower + tileHints.scale_upper) / 2.0;
                     tileHints.scale_lower = midScale * 0.5;
                     tileHints.scale_upper = midScale * 1.5;
                  }
                  expectedRaDec = refined;
               }
            }
         }

         console.writeln("  " + prefix + " start (wave " + wave + ")" +
            (tileHints.scale_lower ? " scale=[" + tileHints.scale_lower.toFixed(1) + "-" + tileHints.scale_upper.toFixed(1) + "]\"/px" : "") +
            (expectedRaDec ? " refined_center=(" + tileHints.center_ra.toFixed(2) + "," + tileHints.center_dec.toFixed(2) +
               ")(ref=[" + nearestTile.col + "," + nearestTile.row + "] dist=" + Math.round(Math.sqrt(nearestDist2)) + "px)" : ""));

         // Solve
         // Use custom tile solver function if provided, otherwise default to API solver
         var solved;
         if (tileSolverFn) {
            solved = tileSolverFn(tile, tileHints, medianScale, expectedRaDec);
         } else {
            solved = solveSingleTile(client, tile, tileHints, medianScale, expectedRaDec);
         }

         if (solved) {
            successCount++;
            solvedTiles.push(tile);
         }

         // Always enqueue unsolved neighbors (even on failure — don't stall wavefront)
         var neighbors = getNeighbors(tile);
         for (var ni = 0; ni < neighbors.length; ni++) {
            var nb = neighbors[ni];
            var nbKey = nb.col + "," + nb.row;
            if (!queued[nbKey] && nb.status === "pending") {
               queue.push(nb);
               queued[nbKey] = true;
            }
         }

         // Print grid
         printTileGrid(tiles, gridX, gridY);

         // Rate limit
         // rateLimitMs: explicit value overrides default (API=2000ms, IS/Local=0ms)
         var rateMs = (rateLimitMs !== undefined) ? rateLimitMs : (tileSolverFn ? 0 : 2000);
         if (rateMs > 0) msleep(rateMs);
      }
   }

   var totalElapsed = (new Date()).getTime() - startTime;
   notify("Solved " + successCount + "/" + tiles.length + " tiles | " + formatElapsed(totalElapsed) + " total", -1);
   console.writeln("");
   console.writeln("<b>Wavefront solve complete: " + successCount + "/" + tiles.length + " succeeded (" + formatElapsed(totalElapsed) + ")</b>");
   printTileGrid(tiles, gridX, gridY);
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

            // Convert to RA/DEC using tile WCS (top-down convention)
            var raDec = pixelToRaDecTD(wcsObj, fullPx, fullPy);
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
      result.crval2.toFixed(6) + ") RMS=" + result.rms_arcsec.toFixed(2) + " arcsec");

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
// pixelOffsetToRaDec
//
// Convert pixel offset from image center to RA/DEC using spherical trigonometry.
// Supports multiple projection types (gnomonic, equisolid, equidistant, stereographic).
//
// centerRA, centerDEC: image center coordinates (degrees)
// pixelScale: arcsec/pixel
// offsetX: pixel offset (positive = West = RA decreasing direction)
// offsetY: pixel offset (positive = North = DEC increasing direction)
// projection: "rectilinear"|"equisolid"|"equidistant"|"stereographic"
//
// Returns {ra, dec} in degrees.
//----------------------------------------------------------------------------
function pixelOffsetToRaDec(centerRA, centerDEC, pixelScale, offsetX, offsetY, projection) {
   var scaleRad = (pixelScale / 3600.0) * Math.PI / 180.0;
   var rPixels = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

   if (rPixels < 0.001) {
      return { ra: centerRA, dec: centerDEC };
   }

   // Direction angle (phi) on the image plane
   var phi = Math.atan2(offsetX, offsetY);

   // Angular distance c from center, depending on projection type
   var rScaled = rPixels * scaleRad;
   var c;
   switch (projection || "rectilinear") {
      case "equisolid":
         c = 2.0 * Math.asin(Math.min(rScaled / 2.0, 1.0));
         break;
      case "equidistant":
         c = rScaled;
         break;
      case "stereographic":
         c = 2.0 * Math.atan(rScaled / 2.0);
         break;
      default: // rectilinear (gnomonic)
         c = Math.atan(rScaled);
         break;
   }

   // Spherical trigonometry: inverse projection
   var alpha0 = centerRA * Math.PI / 180.0;
   var delta0 = centerDEC * Math.PI / 180.0;

   var sinC = Math.sin(c);
   var cosC = Math.cos(c);
   var sinD0 = Math.sin(delta0);
   var cosD0 = Math.cos(delta0);

   var dec = Math.asin(cosC * sinD0 + sinC * cosD0 * Math.cos(phi));
   var ra = alpha0 + Math.atan2(sinC * Math.sin(phi),
                                 cosC * cosD0 - sinC * sinD0 * Math.cos(phi));

   var raDeg = (ra * 180.0 / Math.PI) % 360.0;
   if (raDeg < 0) raDeg += 360.0;
   var decDeg = dec * 180.0 / Math.PI;

   return { ra: raDeg, dec: decDeg };
}

//----------------------------------------------------------------------------
// computeTileHints
//
// Calculate per-tile RA/DEC hints from image center coordinates and tile positions.
//
// tiles: array from splitImageToTiles
// centerRA, centerDEC: image center (degrees)
// pixelScale: arcsec/pixel
// imageWidth, imageHeight: full image dimensions (pixels)
// projection: projection type string
//----------------------------------------------------------------------------
function computeTileHints(tiles, centerRA, centerDEC, pixelScale, imageWidth, imageHeight, projection) {
   var imgCenterX = imageWidth / 2.0;
   var imgCenterY = imageHeight / 2.0;

   for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var tileCenterX = tile.offsetX + tile.tileWidth / 2.0;
      var tileCenterY = tile.offsetY + tile.tileHeight / 2.0;

      // Offset from image center (note: Y is inverted for astronomical convention)
      var dx = imgCenterX - tileCenterX;  // positive = West
      var dy = imgCenterY - tileCenterY;  // positive = North (image Y increases downward)

      var result = pixelOffsetToRaDec(centerRA, centerDEC, pixelScale, dx, dy, projection);
      tile.hintRA = result.ra;
      tile.hintDEC = result.dec;
   }
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

   // Debug: dump WCS of each successful tile
   for (var i = 0; i < successTiles.length; i++) {
      var st = successTiles[i];
      console.writeln("  Tile [" + st.col + "," + st.row + "] WCS: CRVAL=(" +
         st.wcs.crval1.toFixed(4) + "," + st.wcs.crval2.toFixed(4) + ") CRPIX=(" +
         st.wcs.crpix1.toFixed(2) + "," + st.wcs.crpix2.toFixed(2) + ") CD=(" +
         (st.wcs.cd1_1 || 0).toFixed(6) + "," + (st.wcs.cd1_2 || 0).toFixed(6) + "," +
         (st.wcs.cd2_1 || 0).toFixed(6) + "," + (st.wcs.cd2_2 || 0).toFixed(6) +
         ") offset=(" + st.offsetX + "," + st.offsetY + ") size=(" + st.tileWidth + "x" + st.tileHeight + ")");
   }

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

               var sipI = (ti.wcs.sipCoeffs && ti.wcs.aOrder) ? { a: ti.wcs.sipCoeffs.a || [], b: ti.wcs.sipCoeffs.b || [] } : null;
               var sipJ = (tj.wcs.sipCoeffs && tj.wcs.aOrder) ? { a: tj.wcs.sipCoeffs.a || [], b: tj.wcs.sipCoeffs.b || [] } : null;
               var wcsI = {
                  crval1: ti.wcs.crval1, crval2: ti.wcs.crval2,
                  crpix1: ti.wcs.crpix1, crpix2: ti.wcs.crpix2,
                  cd1_1: ti.wcs.cd1_1 || 0, cd1_2: ti.wcs.cd1_2 || 0,
                  cd2_1: ti.wcs.cd2_1 || 0, cd2_2: ti.wcs.cd2_2 || 0,
                  sip: sipI
               };
               var wcsJ = {
                  crval1: tj.wcs.crval1, crval2: tj.wcs.crval2,
                  crpix1: tj.wcs.crpix1, crpix2: tj.wcs.crpix2,
                  cd1_1: tj.wcs.cd1_1 || 0, cd1_2: tj.wcs.cd1_2 || 0,
                  cd2_1: tj.wcs.cd2_1 || 0, cd2_2: tj.wcs.cd2_2 || 0,
                  sip: sipJ
               };

               // WCS CRPIX is in full-image top-down coordinate system
               var rdI = pixelToRaDecTD(wcsI, px, py);
               var rdJ = pixelToRaDecTD(wcsJ, px, py);
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

   // Report tiles with consistently high deviation (warning only, no invalidation)
   // Python version also does not invalidate tiles — WCSFitter handles outliers via least-squares
   var warnings = 0;
   for (var i = 0; i < successTiles.length; i++) {
      if (deviations[i].pairCount === 0) continue;
      var avgDev = deviations[i].totalDev / deviations[i].pairCount;
      if (avgDev > toleranceArcsec * 3) {
         console.writeln("  Tile [" + successTiles[i].col + "," + successTiles[i].row +
            "] WARNING: avg deviation " + avgDev.toFixed(1) + "\" exceeds threshold");
         warnings++;
      }
   }

   console.writeln("Overlap validation: " + pairsChecked + " pairs checked, " + warnings + " tiles with high deviation");
   return 0;
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

//============================================================================
// Settings Dialog
//============================================================================

function SolverSettingsDialog(parent) {
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = "Settings";

   var d = this;

   // Load saved settings
   var savedMode = Settings.read(SETTINGS_KEY + "/solveMode", DataType_String);
   var savedApiKey = Settings.read(SETTINGS_KEY + "/apiKey", DataType_String);
   var savedPythonPath = Settings.read(SETTINGS_KEY + "/pythonPath", DataType_String);
   var savedScriptDir = Settings.read(SETTINGS_KEY + "/scriptDir", DataType_String);
   var savedSaveTiles = Settings.read(SETTINGS_KEY + "/saveTiles", DataType_Boolean);
   var savedTileOutputDir = Settings.read(SETTINGS_KEY + "/tileOutputDir", DataType_String);

   this._solveMode = savedMode || "api";
   this._apiKey = savedApiKey || "";
   this._pythonPath = savedPythonPath || "";
   this._scriptDir = savedScriptDir || "";
   this._saveTiles = (savedSaveTiles === null || savedSaveTiles === undefined) ? false : savedSaveTiles;
   this._tileOutputDir = savedTileOutputDir || "";

   // ---- Solve Mode ----
   var modeGroup = new GroupBox(this);
   modeGroup.title = "Solve Mode";

   var modeLabel = new Label(modeGroup);
   modeLabel.text = "Mode:";
   modeLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   modeLabel.setFixedWidth(120);

   this.modeCombo = new ComboBox(modeGroup);
   this.modeCombo.addItem("API (astrometry.net)");
   this.modeCombo.addItem("Local (solve-field)");
   this.modeCombo.addItem("ImageSolver (built-in)");
   this.modeCombo.currentItem = (this._solveMode === "local") ? 1 : (this._solveMode === "imagesolver") ? 2 : 0;
   this.modeCombo.toolTip = "API: astrometry.net API (Python不要)\nLocal: ローカル solve-field (Python必須)\nImageSolver: PixInsight内蔵ソルバー (カタログ自動取得)";

   var modeSizer = new HorizontalSizer;
   modeSizer.spacing = 4;
   modeSizer.add(modeLabel);
   modeSizer.add(this.modeCombo, 100);

   modeGroup.sizer = new VerticalSizer;
   modeGroup.sizer.margin = 6;
   modeGroup.sizer.spacing = 4;
   modeGroup.sizer.add(modeSizer);

   // ---- API Settings ----
   var apiGroup = new GroupBox(this);
   apiGroup.title = "API Settings";

   var apiKeyLabel = new Label(apiGroup);
   apiKeyLabel.text = "API Key:";
   apiKeyLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   apiKeyLabel.setFixedWidth(120);

   this.apiKeyEdit = new Edit(apiGroup);
   this.apiKeyEdit.text = this._apiKey;
   this.apiKeyEdit.passwordMode = true;
   this.apiKeyEdit.setMinWidth(300);
   this.apiKeyEdit.toolTip = "Your nova.astrometry.net API key";

   var apiKeySizer = new HorizontalSizer;
   apiKeySizer.spacing = 4;
   apiKeySizer.add(apiKeyLabel);
   apiKeySizer.add(this.apiKeyEdit, 100);

   this.showKeyCheck = new CheckBox(apiGroup);
   this.showKeyCheck.text = "Show key";
   this.showKeyCheck.checked = false;
   this.showKeyCheck.onCheck = function(checked) {
      d.apiKeyEdit.passwordMode = !checked;
   };

   var apiInfoLabel = new Label(apiGroup);
   apiInfoLabel.text = "Get a free API key at nova.astrometry.net";

   apiGroup.sizer = new VerticalSizer;
   apiGroup.sizer.margin = 6;
   apiGroup.sizer.spacing = 4;
   apiGroup.sizer.add(apiKeySizer);
   apiGroup.sizer.add(this.showKeyCheck);
   apiGroup.sizer.add(apiInfoLabel);

   // ---- Local Settings ----
   var localGroup = new GroupBox(this);
   localGroup.title = "Local Settings";

   var pythonLabel = new Label(localGroup);
   pythonLabel.text = "Python:";
   pythonLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   pythonLabel.setFixedWidth(120);

   this.pythonEdit = new Edit(localGroup);
   this.pythonEdit.text = this._pythonPath;
   this.pythonEdit.toolTip = "Path to Python executable (e.g., /usr/local/bin/python3 or .venv/bin/python3)";

   this.pythonBrowse = new ToolButton(localGroup);
   this.pythonBrowse.icon = this.scaledResource(":/browser/select-file.png");
   this.pythonBrowse.setScaledFixedSize(24, 24);
   this.pythonBrowse.toolTip = "Browse for Python executable";
   this.pythonBrowse.onClick = function() {
      var ofd = new OpenFileDialog;
      ofd.caption = "Select Python Executable";
      if (d.pythonEdit.text.length > 0) {
         ofd.initialPath = d.pythonEdit.text;
      }
      if (ofd.execute()) {
         d.pythonEdit.text = ofd.fileName;
      }
   };

   var pythonSizer = new HorizontalSizer;
   pythonSizer.spacing = 4;
   pythonSizer.add(pythonLabel);
   pythonSizer.add(this.pythonEdit, 100);
   pythonSizer.add(this.pythonBrowse);

   var scriptDirLabel = new Label(localGroup);
   scriptDirLabel.text = "Script directory:";
   scriptDirLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   scriptDirLabel.setFixedWidth(120);

   this.scriptDirEdit = new Edit(localGroup);
   this.scriptDirEdit.text = this._scriptDir;
   this.scriptDirEdit.toolTip = "Path to split-image-solver repository directory";

   this.scriptDirBrowse = new ToolButton(localGroup);
   this.scriptDirBrowse.icon = this.scaledResource(":/browser/select-file.png");
   this.scriptDirBrowse.setScaledFixedSize(24, 24);
   this.scriptDirBrowse.toolTip = "Browse for script directory";
   this.scriptDirBrowse.onClick = function() {
      var gdd = new GetDirectoryDialog;
      gdd.caption = "Select Script Directory";
      if (d.scriptDirEdit.text.length > 0) {
         gdd.initialPath = d.scriptDirEdit.text;
      }
      if (gdd.execute()) {
         d.scriptDirEdit.text = gdd.directory;
      }
   };

   var scriptDirSizer = new HorizontalSizer;
   scriptDirSizer.spacing = 4;
   scriptDirSizer.add(scriptDirLabel);
   scriptDirSizer.add(this.scriptDirEdit, 100);
   scriptDirSizer.add(this.scriptDirBrowse);

   localGroup.sizer = new VerticalSizer;
   localGroup.sizer.margin = 6;
   localGroup.sizer.spacing = 4;
   localGroup.sizer.add(pythonSizer);
   localGroup.sizer.add(scriptDirSizer);

   // ---- Tile Output Settings ----
   var tileGroup = new GroupBox(this);
   tileGroup.title = "Tile Output";

   this.saveTilesCheck = new CheckBox(tileGroup);
   this.saveTilesCheck.text = "Save tile files";
   this.saveTilesCheck.checked = this._saveTiles;
   this.saveTilesCheck.toolTip = "Save split tile FITS files to the specified directory";

   var tileOutputDirLabel = new Label(tileGroup);
   tileOutputDirLabel.text = "Output directory:";
   tileOutputDirLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   tileOutputDirLabel.setFixedWidth(120);

   this.tileOutputDirEdit = new Edit(tileGroup);
   this.tileOutputDirEdit.text = this._tileOutputDir;
   this.tileOutputDirEdit.toolTip = "Directory to save tile FITS files";
   this.tileOutputDirEdit.enabled = this._saveTiles;

   this.tileOutputDirBrowse = new ToolButton(tileGroup);
   this.tileOutputDirBrowse.icon = this.scaledResource(":/browser/select-file.png");
   this.tileOutputDirBrowse.setScaledFixedSize(24, 24);
   this.tileOutputDirBrowse.toolTip = "Browse for output directory";
   this.tileOutputDirBrowse.enabled = this._saveTiles;
   this.tileOutputDirBrowse.onClick = function() {
      var gdd = new GetDirectoryDialog;
      gdd.caption = "Select Tile Output Directory";
      if (d.tileOutputDirEdit.text.length > 0) {
         gdd.initialPath = d.tileOutputDirEdit.text;
      }
      if (gdd.execute()) {
         d.tileOutputDirEdit.text = gdd.directory;
      }
   };

   this.saveTilesCheck.onCheck = function(checked) {
      d.tileOutputDirEdit.enabled = checked;
      d.tileOutputDirBrowse.enabled = checked;
   };

   var tileOutputDirSizer = new HorizontalSizer;
   tileOutputDirSizer.spacing = 4;
   tileOutputDirSizer.add(tileOutputDirLabel);
   tileOutputDirSizer.add(d.tileOutputDirEdit, 100);
   tileOutputDirSizer.add(d.tileOutputDirBrowse);

   tileGroup.sizer = new VerticalSizer;
   tileGroup.sizer.margin = 6;
   tileGroup.sizer.spacing = 4;
   tileGroup.sizer.add(d.saveTilesCheck);
   tileGroup.sizer.add(tileOutputDirSizer);

   // ---- Buttons ----
   var okButton = new PushButton(this);
   okButton.text = "OK";
   okButton.icon = this.scaledResource(":/icons/ok.png");
   okButton.onClick = function() { d.ok(); };

   var cancelButton = new PushButton(this);
   cancelButton.text = "Cancel";
   cancelButton.icon = this.scaledResource(":/icons/cancel.png");
   cancelButton.onClick = function() { d.cancel(); };

   var btnSizer = new HorizontalSizer;
   btnSizer.addStretch();
   btnSizer.spacing = 8;
   btnSizer.add(okButton);
   btnSizer.add(cancelButton);

   // ---- Layout ----
   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 8;
   this.sizer.add(modeGroup);
   this.sizer.add(apiGroup);
   this.sizer.add(localGroup);
   this.sizer.add(tileGroup);
   this.sizer.addSpacing(4);
   this.sizer.add(btnSizer);

   this.adjustToContents();
}

SolverSettingsDialog.prototype = new Dialog;

// Save all settings and return values as object
SolverSettingsDialog.prototype.getSettings = function() {
   var mode = (this.modeCombo.currentItem === 1) ? "local" : (this.modeCombo.currentItem === 2) ? "imagesolver" : "api";
   var apiKey = this.apiKeyEdit.text.trim();
   var pythonPath = this.pythonEdit.text.trim();
   var scriptDir = this.scriptDirEdit.text.trim();
   var saveTiles = this.saveTilesCheck.checked;
   var tileOutputDir = this.tileOutputDirEdit.text.trim();

   Settings.write(SETTINGS_KEY + "/solveMode", DataType_String, mode);
   Settings.write(SETTINGS_KEY + "/apiKey", DataType_String, apiKey);
   Settings.write(SETTINGS_KEY + "/pythonPath", DataType_String, pythonPath);
   Settings.write(SETTINGS_KEY + "/scriptDir", DataType_String, scriptDir);
   Settings.write(SETTINGS_KEY + "/saveTiles", DataType_Boolean, saveTiles);
   Settings.write(SETTINGS_KEY + "/tileOutputDir", DataType_String, tileOutputDir);

   return {
      solveMode: mode,
      apiKey: apiKey,
      pythonPath: pythonPath,
      scriptDir: scriptDir,
      saveTiles: saveTiles,
      tileOutputDir: tileOutputDir
   };
};

//============================================================================
// Image Preview - STF stretch and bitmap utilities
//============================================================================

#define MAX_PREVIEW_EDGE 1024

function computeAutoSTF(image, channel) {
   if (typeof channel === "undefined") channel = 0;
   var savedChannel = image.selectedChannel;
   image.selectedChannel = channel;
   var median = image.median();

   var mad;
   try {
      mad = image.MAD();
   } catch (e) {
      mad = image.avgDev() * 1.4826;
   }
   image.selectedChannel = savedChannel;

   if (mad === 0 || mad < 1e-15) {
      return { shadowClip: 0.0, midtone: 0.5 };
   }

   var targetMedian = 0.25;
   var shadowClipK = -2.8;

   var shadow = median + shadowClipK * mad;
   if (shadow < 0) shadow = 0;

   var normalizedMedian = (median - shadow) / (1.0 - shadow);
   if (normalizedMedian <= 0) normalizedMedian = 1e-6;
   if (normalizedMedian >= 1) normalizedMedian = 1 - 1e-6;

   var m = (targetMedian - 1.0) * normalizedMedian /
           ((2.0 * targetMedian - 1.0) * normalizedMedian - targetMedian);
   if (m < 0) m = 0;
   if (m > 1) m = 1;

   return { shadowClip: shadow, midtone: m };
}

function midtonesTransferFunction(m, x) {
   if (x <= 0) return 0;
   if (x >= 1) return 1;
   if (m === 0) return 0;
   if (m === 1) return 1;
   if (m === 0.5) return x;
   return ((m - 1.0) * x) / ((2.0 * m - 1.0) * x - m);
}

// stretchMode: "none" / "linked" / "unlinked" (default "linked")
function createStretchedBitmap(image, maxEdge, stretchMode) {
   if (typeof maxEdge === "undefined") maxEdge = MAX_PREVIEW_EDGE;
   if (typeof stretchMode === "undefined") stretchMode = "linked";

   var w = image.width;
   var h = image.height;

   var scale = 1.0;
   if (maxEdge > 0) {
      var maxDim = Math.max(w, h);
      if (maxDim > maxEdge) {
         scale = maxEdge / maxDim;
      }
   }

   var bmpW = Math.round(w * scale);
   var bmpH = Math.round(h * scale);

   var isColor = image.numberOfChannels >= 3;

   // Compute STF parameters per mode
   var stfR, stfG, stfB;
   if (stretchMode === "linked") {
      stfR = computeAutoSTF(image, 0);
      stfG = stfR;
      stfB = stfR;
   } else if (stretchMode === "unlinked" && isColor) {
      stfR = computeAutoSTF(image, 0);
      stfG = computeAutoSTF(image, 1);
      stfB = computeAutoSTF(image, 2);
   } else if (stretchMode === "unlinked") {
      stfR = computeAutoSTF(image, 0);
      stfG = stfR;
      stfB = stfR;
   }

   var bmp = new Bitmap(bmpW, bmpH);

   for (var by = 0; by < bmpH; by++) {
      for (var bx = 0; bx < bmpW; bx++) {
         var ix = Math.min(Math.floor(bx / scale), w - 1);
         var iy = Math.min(Math.floor(by / scale), h - 1);

         var r, g, b;
         if (isColor) {
            r = image.sample(ix, iy, 0);
            g = image.sample(ix, iy, 1);
            b = image.sample(ix, iy, 2);
         } else {
            r = g = b = image.sample(ix, iy, 0);
         }

         if (stretchMode === "none") {
            r = Math.max(0, Math.min(1, r));
            g = Math.max(0, Math.min(1, g));
            b = Math.max(0, Math.min(1, b));
         } else {
            r = (r - stfR.shadowClip) / (1.0 - stfR.shadowClip);
            g = (g - stfG.shadowClip) / (1.0 - stfG.shadowClip);
            b = (b - stfB.shadowClip) / (1.0 - stfB.shadowClip);

            r = midtonesTransferFunction(stfR.midtone, Math.max(0, Math.min(1, r)));
            g = midtonesTransferFunction(stfG.midtone, Math.max(0, Math.min(1, g)));
            b = midtonesTransferFunction(stfB.midtone, Math.max(0, Math.min(1, b)));
         }

         var ri = Math.round(r * 255);
         var gi = Math.round(g * 255);
         var bi = Math.round(b * 255);
         bmp.setPixel(bx, by, 0xFF000000 | (ri << 16) | (gi << 8) | bi);
      }
   }

   return { bitmap: bmp, scale: scale, width: bmpW, height: bmpH };
}

//============================================================================
// Grid Preview Control - Image preview with grid overlay
//============================================================================

function GridPreviewControl(parent) {
   this.__base__ = ScrollBox;
   this.__base__(parent);

   this.bitmap = null;
   this.bitmapScale = 1.0;
   this.zoomLevel = 1.0;
   this.gridCols = 1;
   this.gridRows = 1;
   this.overlapPx = 100;
   this.imageWidth = 0;
   this.imageHeight = 0;

   // Manual scroll management
   this.scrollX = 0;
   this.scrollY = 0;

   // Drag for pan
   this.isDragging = false;
   this.hasMoved = false;
   this.dragStartX = 0;
   this.dragStartY = 0;
   this.panScrollX = 0;
   this.panScrollY = 0;

   this.zoomLevels = [
      0.0625, 0.125, 0.25, 0.5, 0.75,
      1.0, 1.5, 2.0, 3.0, 4.0
   ];
   this.zoomIndex = 5;

   this.autoScrolls = false;

   var self = this;

   this.viewport.cursor = new Cursor(StdCursor_Arrow);
   this._needsFit = true;

   // Fit to window on first resize (viewport size is 0 during construction)
   this.viewport.onResize = function() {
      if (self._needsFit && self.bitmap) {
         self._needsFit = false;
         self.fitToWindow();
      }
   };

   this.onHorizontalScrollPosUpdated = function(pos) {
      self.scrollX = pos;
      self.viewport.update();
   };
   this.onVerticalScrollPosUpdated = function(pos) {
      self.scrollY = pos;
      self.viewport.update();
   };

   // --- Paint ---
   this.viewport.onPaint = function() {
      var g = new Graphics(this);
      g.fillRect(this.boundsRect, new Brush(0xFF202020));

      if (self.bitmap) {
         var dispW = Math.round(self.bitmap.width * self.zoomLevel);
         var dispH = Math.round(self.bitmap.height * self.zoomLevel);

         // Draw the stretched image
         g.drawScaledBitmap(
            new Rect(-self.scrollX, -self.scrollY,
                     dispW - self.scrollX, dispH - self.scrollY),
            self.bitmap);

         // Draw grid lines
         if (self.gridCols > 1 || self.gridRows > 1) {
            var imgW = self.imageWidth;
            var imgH = self.imageHeight;
            var cols = self.gridCols;
            var rows = self.gridRows;
            var overlap = self.overlapPx;

            // Compute tile boundaries (same logic as splitImageToTiles)
            var tileW = Math.floor((imgW + (cols - 1) * overlap) / cols);
            var tileH = Math.floor((imgH + (rows - 1) * overlap) / rows);
            var stepX = tileW - overlap;
            var stepY = tileH - overlap;

            // Scale factor: original image pixels -> bitmap pixels -> display pixels
            var toDisp = self.bitmapScale * self.zoomLevel;

            g.pen = new Pen(0xBB00FF00, 1.5);
            g.antialiasing = true;

            // Vertical grid lines (between columns)
            for (var c = 1; c < cols; c++) {
               var x = c * stepX;
               var dx = Math.round(x * toDisp) - self.scrollX;
               g.drawLine(dx, -self.scrollY, dx, dispH - self.scrollY);
            }

            // Horizontal grid lines (between rows)
            for (var r = 1; r < rows; r++) {
               var y = r * stepY;
               var dy = Math.round(y * toDisp) - self.scrollY;
               g.drawLine(-self.scrollX, dy, dispW - self.scrollX, dy);
            }

            // Draw overlap regions (semi-transparent)
            if (overlap > 0) {
               g.pen = new Pen(0x5500AAFF, 1.0);

               // Vertical overlap bands
               for (var c = 1; c < cols; c++) {
                  var xStart = c * stepX;
                  var xEnd = xStart + overlap;
                  var dxs = Math.round(xStart * toDisp) - self.scrollX;
                  var dxe = Math.round(xEnd * toDisp) - self.scrollX;
                  // Left overlap edge
                  g.drawLine(dxs, -self.scrollY, dxs, dispH - self.scrollY);
                  // Right overlap edge
                  g.drawLine(dxe, -self.scrollY, dxe, dispH - self.scrollY);
               }

               // Horizontal overlap bands
               for (var r = 1; r < rows; r++) {
                  var yStart = r * stepY;
                  var yEnd = yStart + overlap;
                  var dys = Math.round(yStart * toDisp) - self.scrollY;
                  var dye = Math.round(yEnd * toDisp) - self.scrollY;
                  g.drawLine(-self.scrollX, dys, dispW - self.scrollX, dys);
                  g.drawLine(-self.scrollX, dye, dispW - self.scrollX, dye);
               }
            }

            // Skip edge info
            var sk = self.skipEdges || { top: 0, bottom: 0, left: 0, right: 0 };

            // Draw skipped tile overlay (semi-transparent dark)
            for (var r = 0; r < rows; r++) {
               for (var c = 0; c < cols; c++) {
                  var isSkipped = (r < sk.top || r >= rows - sk.bottom ||
                                   c < sk.left || c >= cols - sk.right);
                  if (isSkipped) {
                     var rx0 = Math.round(c * stepX * toDisp) - self.scrollX;
                     var ry0 = Math.round(r * stepY * toDisp) - self.scrollY;
                     var rx1 = Math.round((c * stepX + tileW) * toDisp) - self.scrollX;
                     var ry1 = Math.round((r * stepY + tileH) * toDisp) - self.scrollY;
                     g.fillRect(new Rect(rx0, ry0, rx1, ry1), new Brush(0x88000000));
                  }
               }
            }

            // Tile labels
            g.pen = new Pen(0xCCFFFF00);
            g.font = new Font("Helvetica", 10);
            for (var r = 0; r < rows; r++) {
               for (var c = 0; c < cols; c++) {
                  var isSkipped2 = (r < sk.top || r >= rows - sk.bottom ||
                                    c < sk.left || c >= cols - sk.right);
                  var tx = c * stepX + tileW / 2;
                  var ty = r * stepY + tileH / 2;
                  var lx = Math.round(tx * toDisp) - self.scrollX - 8;
                  var ly = Math.round(ty * toDisp) - self.scrollY - 6;
                  if (isSkipped2) {
                     g.pen = new Pen(0x66FF6666);
                     g.drawText(lx, ly, "skip");
                     g.pen = new Pen(0xCCFFFF00);
                  } else {
                     g.drawText(lx, ly, "" + (r * cols + c + 1));
                  }
               }
            }
         }
      }

      g.end();
   };

   // --- Mouse events for pan ---
   #define GRID_DRAG_THRESHOLD 4

   this.viewport.onMousePress = function(x, y, button, buttonState, modifiers) {
      if (!self.bitmap) return;
      if (button === 1 || button === 4) {
         self.isDragging = true;
         self.hasMoved = false;
         self.dragStartX = x;
         self.dragStartY = y;
         self.panScrollX = self.scrollX;
         self.panScrollY = self.scrollY;
      }
   };

   this.viewport.onMouseMove = function(x, y, buttonState, modifiers) {
      if (!self.isDragging) return;
      var dx = x - self.dragStartX;
      var dy = y - self.dragStartY;
      if (!self.hasMoved) {
         if (Math.abs(dx) > GRID_DRAG_THRESHOLD || Math.abs(dy) > GRID_DRAG_THRESHOLD) {
            self.hasMoved = true;
            self.viewport.cursor = new Cursor(StdCursor_ClosedHand);
         }
      }
      if (self.hasMoved) {
         self.setScroll(self.panScrollX - dx, self.panScrollY - dy);
      }
   };

   this.viewport.onMouseRelease = function(x, y, button, buttonState, modifiers) {
      if (!self.isDragging) return;
      self.isDragging = false;
      self.hasMoved = false;
      self.viewport.cursor = new Cursor(StdCursor_Arrow);
   };

   this.viewport.onMouseWheel = function(x, y, delta, buttonState, modifiers) {
      if (!self.bitmap) return;
      var oldZoom = self.zoomLevel;
      var newIdx = self.zoomIndex;

      if (delta > 0) {
         for (var i = 0; i < self.zoomLevels.length; i++) {
            if (self.zoomLevels[i] > oldZoom + 1e-6) { newIdx = i; break; }
         }
      } else {
         for (var i = self.zoomLevels.length - 1; i >= 0; i--) {
            if (self.zoomLevels[i] < oldZoom - 1e-6) { newIdx = i; break; }
         }
      }
      if (newIdx === self.zoomIndex) return;

      var newZoom = self.zoomLevels[newIdx];
      var factor = newZoom / oldZoom;
      self.zoomIndex = newIdx;
      self.zoomLevel = newZoom;
      self.scrollX = Math.round((self.scrollX + x) * factor - x);
      self.scrollY = Math.round((self.scrollY + y) * factor - y);
      self.updateViewport();
   };
}

GridPreviewControl.prototype = new ScrollBox;

GridPreviewControl.prototype.setScroll = function(sx, sy) {
   var dbmp = this.bitmap;
   if (!dbmp) return;
   var dispW = Math.round(dbmp.width * this.zoomLevel);
   var dispH = Math.round(dbmp.height * this.zoomLevel);
   var maxX = Math.max(0, dispW - this.viewport.width);
   var maxY = Math.max(0, dispH - this.viewport.height);
   this.scrollX = Math.max(0, Math.min(sx, maxX));
   this.scrollY = Math.max(0, Math.min(sy, maxY));
   this.horizontalScrollPosition = this.scrollX;
   this.verticalScrollPosition = this.scrollY;
   this.viewport.update();
};

GridPreviewControl.prototype.updateViewport = function() {
   var dbmp = this.bitmap;
   if (!dbmp) {
      this.setHorizontalScrollRange(0, 0);
      this.setVerticalScrollRange(0, 0);
      this.viewport.update();
      return;
   }
   var dispW = Math.round(dbmp.width * this.zoomLevel);
   var dispH = Math.round(dbmp.height * this.zoomLevel);
   var viewW = this.viewport.width;
   var viewH = this.viewport.height;

   this.setHorizontalScrollRange(0, Math.max(0, dispW - viewW));
   this.setVerticalScrollRange(0, Math.max(0, dispH - viewH));

   // Clamp scroll
   if (this.scrollX > Math.max(0, dispW - viewW))
      this.scrollX = Math.max(0, dispW - viewW);
   if (this.scrollY > Math.max(0, dispH - viewH))
      this.scrollY = Math.max(0, dispH - viewH);

   this.horizontalScrollPosition = this.scrollX;
   this.verticalScrollPosition = this.scrollY;
   this.viewport.update();
};

GridPreviewControl.prototype.fitToWindow = function() {
   if (!this.bitmap) return;
   var viewW = this.viewport.width;
   var viewH = this.viewport.height;
   if (viewW <= 0 || viewH <= 0) return;

   var scaleX = viewW / this.bitmap.width;
   var scaleY = viewH / this.bitmap.height;
   var fitZoom = Math.min(scaleX, scaleY);

   // Use exact fit zoom (not snapped to preset levels)
   this.zoomLevel = fitZoom;
   // Set zoomIndex to nearest preset for wheel zoom reference
   this.zoomIndex = 0;
   for (var i = this.zoomLevels.length - 1; i >= 0; i--) {
      if (this.zoomLevels[i] <= fitZoom + 1e-6) {
         this.zoomIndex = i;
         break;
      }
   }
   this.scrollX = 0;
   this.scrollY = 0;
   this.updateViewport();
};

GridPreviewControl.prototype.setBitmap = function(bmp, bmpScale, imgW, imgH) {
   this.bitmap = bmp;
   this.bitmapScale = bmpScale;
   this.imageWidth = imgW;
   this.imageHeight = imgH;
   this.fitToWindow();
};

GridPreviewControl.prototype.setGrid = function(cols, rows, overlapPx, skipEdges) {
   this.gridCols = cols;
   this.gridRows = rows;
   this.overlapPx = overlapPx;
   this.skipEdges = skipEdges || { top: 0, bottom: 0, left: 0, right: 0 };
   this.viewport.update();
};

//============================================================================
// Main Dialog
//============================================================================

function SplitSolverDialog() {
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = TITLE + " v" + VERSION + VERSION_SUFFIX;

   var self = this;

   // Load saved settings
   var savedMode = Settings.read(SETTINGS_KEY + "/solveMode", DataType_String);
   var savedApiKey = Settings.read(SETTINGS_KEY + "/apiKey", DataType_String);
   var savedPythonPath = Settings.read(SETTINGS_KEY + "/pythonPath", DataType_String);
   var savedScriptDir = Settings.read(SETTINGS_KEY + "/scriptDir", DataType_String);
   var savedCamera = Settings.read(SETTINGS_KEY + "/camera", DataType_String);
   var savedLens = Settings.read(SETTINGS_KEY + "/lens", DataType_String);
   var savedSaveTiles2 = Settings.read(SETTINGS_KEY + "/saveTiles", DataType_Boolean);
   var savedTileOutputDir2 = Settings.read(SETTINGS_KEY + "/tileOutputDir", DataType_String);

   this._solveMode = savedMode || "api";
   this._apiKey = savedApiKey || "";
   this._pythonPath = savedPythonPath || "";
   this._scriptDir = savedScriptDir || "";
   this._saveTiles = (savedSaveTiles2 === null || savedSaveTiles2 === undefined) ? false : savedSaveTiles2;
   this._tileOutputDir = savedTileOutputDir2 || "";

   // ---- Target image ----
   var targetWindow = ImageWindow.activeWindow;

   this.targetLabel = new Label(this);
   this.targetLabel.text = "Target:";
   this.targetLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.targetLabel.setFixedWidth(120);

   this.targetEdit = new Edit(this);
   this.targetEdit.readOnly = true;
   this.targetEdit.text = targetWindow.isNull ? "(No active image)" : targetWindow.mainView.id;

   var targetSizer = new HorizontalSizer;
   targetSizer.spacing = 8;
   targetSizer.add(this.targetLabel);
   targetSizer.add(this.targetEdit, 100);

   // Solve mode radio buttons
   var modeLabel = new Label(this);
   modeLabel.text = "Solve mode:";
   modeLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   modeLabel.setFixedWidth(120);

   this.modeApiRadio = new RadioButton(this);
   this.modeApiRadio.text = "API";
   this.modeApiRadio.checked = (this._solveMode === "api");
   this.modeApiRadio.toolTip = "astrometry.net API (APIキー必要)";
   this.modeApiRadio.onCheck = function(checked) {
      if (checked) { self._solveMode = "api"; updateModeUI(); }
   };

   this.modeLocalRadio = new RadioButton(this);
   this.modeLocalRadio.text = "Local";
   this.modeLocalRadio.checked = (this._solveMode === "local");
   this.modeLocalRadio.toolTip = "ローカル solve-field (Python必要)";
   this.modeLocalRadio.onCheck = function(checked) {
      if (checked) { self._solveMode = "local"; updateModeUI(); }
   };

   this.modeISRadio = new RadioButton(this);
   this.modeISRadio.text = "ImageSolver";
   this.modeISRadio.checked = (this._solveMode === "imagesolver");
   this.modeISRadio.toolTip = "PixInsight内蔵 ImageSolver (Single only)";
   this.modeISRadio.onCheck = function(checked) {
      if (checked) { self._solveMode = "imagesolver"; updateModeUI(); }
   };

   var modeSizer = new HorizontalSizer;
   modeSizer.spacing = 8;
   modeSizer.add(modeLabel);
   modeSizer.add(this.modeApiRadio);
   modeSizer.add(this.modeLocalRadio);
   modeSizer.add(this.modeISRadio);
   modeSizer.addStretch();

   // ---- Equipment (Camera + Lens) ----
   var equipDB = loadEquipmentDB();
   this.equipDB = equipDB;

   this.cameraLabel = new Label(this);
   this.cameraLabel.text = "Camera:";
   this.cameraLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.cameraLabel.setFixedWidth(120);

   this.cameraCombo = new ComboBox(this);
   this.cameraCombo.addItem("(Select)");
   if (equipDB && equipDB.cameras) {
      for (var ci = 0; ci < equipDB.cameras.length; ci++) {
         var camEntry = equipDB.cameras[ci];
         var camDisplay = camEntry.instrume
            ? camEntry.name + " (" + camEntry.instrume + ")"
            : camEntry.name;
         this.cameraCombo.addItem(camDisplay);
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

   // Fallback: restore last used camera from Settings
   if (this.cameraCombo.currentItem === 0 && savedCamera && savedCamera.length > 0 && equipDB && equipDB.cameras) {
      for (var sci = 0; sci < equipDB.cameras.length; sci++) {
         if (equipDB.cameras[sci].name === savedCamera) {
            this.cameraCombo.currentItem = sci + 1;
            console.writeln("Restored camera from settings: " + savedCamera);
            break;
         }
      }
   }

   this.lensLabel = new Label(this);
   this.lensLabel.text = "Lens:";
   this.lensLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.lensLabel.setFixedWidth(120);

   this.lensCombo = new ComboBox(this);
   this.lensCombo.addItem("(Select)");
   if (equipDB && equipDB.lenses) {
      for (var li = 0; li < equipDB.lenses.length; li++) {
         var lensEntry = equipDB.lenses[li];
         var lensDisplay = lensEntry.model
            ? lensEntry.model + " (" + lensEntry.name + ")"
            : lensEntry.name;
         this.lensCombo.addItem(lensDisplay);
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

   // Fallback: restore last used lens from Settings
   if (this.lensCombo.currentItem === 0 && savedLens && savedLens.length > 0 && equipDB && equipDB.lenses) {
      for (var sli = 0; sli < equipDB.lenses.length; sli++) {
         if (equipDB.lenses[sli].name === savedLens) {
            this.lensCombo.currentItem = sli + 1;
            console.writeln("Restored lens from settings: " + savedLens);
            break;
         }
      }
   }

   var cameraSizer = new HorizontalSizer;
   cameraSizer.spacing = 6;
   cameraSizer.add(this.cameraLabel);
   cameraSizer.add(this.cameraCombo, 100);

   var lensSizer = new HorizontalSizer;
   lensSizer.spacing = 6;
   lensSizer.add(this.lensLabel);
   lensSizer.add(this.lensCombo, 100);

   // ---- FOV info + recommended grid ----
   this.fovInfoLabel = new Label(this);
   this.fovInfoLabel.text = "";
   this.fovInfoLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   // Need imageWidth/imageHeight for scale correction when image is resampled
   var imageWidth = targetWindow.isNull ? 0 : targetWindow.mainView.image.width;
   var imageHeight = targetWindow.isNull ? 0 : targetWindow.mainView.image.height;

   // ---- Focal Length ----
   this.focalLengthLabel = new Label(this);
   this.focalLengthLabel.text = "Focal length:";
   this.focalLengthLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.focalLengthLabel.setFixedWidth(120);

   this.focalLengthEdit = new Edit(this);
   this.focalLengthEdit.setFixedWidth(100);
   this.focalLengthEdit.toolTip = "Focal length in mm";

   this.focalLengthUnitLabel = new Label(this);
   this.focalLengthUnitLabel.text = "mm";

   // ---- Pixel Pitch ----
   this.pixelPitchLabel = new Label(this);
   this.pixelPitchLabel.text = "Pixel pitch:";
   this.pixelPitchLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.pixelPitchLabel.setFixedWidth(120);

   this.pixelPitchEdit = new Edit(this);
   this.pixelPitchEdit.setFixedWidth(100);
   this.pixelPitchEdit.toolTip = "Pixel pitch (pixel size) in micrometers";

   this.pixelPitchUnitLabel = new Label(this);
   this.pixelPitchUnitLabel.text = "\u00B5m";

   // ---- Drizzle Scale ----
   this.drizzleLabel = new Label(this);
   this.drizzleLabel.text = "Drizzle:";
   this.drizzleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.drizzleLabel.setFixedWidth(120);

   this.drizzleCombo = new ComboBox(this);
   this.drizzleCombo.addItem("None (1x)");
   this.drizzleCombo.addItem("2x");
   this.drizzleCombo.addItem("3x");
   this.drizzleCombo.addItem("4x");
   var savedDrizzle = Settings.read(SETTINGS_KEY + "/drizzleFactor", DataType_Int32);
   this.drizzleCombo.currentItem = (savedDrizzle !== null && savedDrizzle >= 0 && savedDrizzle <= 3) ? savedDrizzle : 0;
   this.drizzleCombo.toolTip = "Drizzle integration scale factor. Adjusts effective pixel pitch for plate solving.";

   // ---- Scale info (computed, read-only display) ----
   this.scaleInfoLabel = new Label(this);
   this.scaleInfoLabel.text = "";

   // ---- Scale Error ----
   this.scaleErrorLabel = new Label(this);
   this.scaleErrorLabel.text = "Error:";
   this.scaleErrorLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.scaleErrorEdit = new Edit(this);
   this.scaleErrorEdit.text = "30";
   this.scaleErrorEdit.setFixedWidth(50);
   this.scaleErrorEdit.toolTip = "Scale estimation error (%)";

   this.scaleErrorUnitLabel = new Label(this);
   this.scaleErrorUnitLabel.text = "%";

   // Update scale and FOV from focal length and pixel pitch
   var updateScaleAndFov = function() {
      var fl = parseFloat(self.focalLengthEdit.text);
      var pp = parseFloat(self.pixelPitchEdit.text);

      if (!isNaN(fl) && fl > 0 && !isNaN(pp) && pp > 0) {
         var nativeScale = computePixelScale(pp, fl);

         // Correct for resampled images (e.g., drizzle/stacking)
         var ps = nativeScale;
         var resampleApplied = false;
         var camIdx = self.cameraCombo.currentItem - 1;
         if (equipDB && camIdx >= 0 && camIdx < equipDB.cameras.length) {
            var cam = equipDB.cameras[camIdx];
            if (imageWidth > 0 && cam.sensor_width > 0 && imageWidth !== cam.sensor_width) {
               var resampleRatio = cam.sensor_width / imageWidth;
               ps = nativeScale * resampleRatio;
               resampleApplied = true;
               console.writeln("Scale corrected for resampled image: " +
                  nativeScale.toFixed(3) + " -> " + ps.toFixed(3) + " arcsec/px" +
                  " (image: " + imageWidth + "x" + imageHeight +
                  " vs sensor: " + cam.sensor_width + "x" + cam.sensor_height + ")");
            }
         }

         // Apply drizzle scale factor only when resample correction was NOT applied.
         // If resample correction is active, it already accounts for drizzle
         // (sensor pixel count vs actual image pixel count includes drizzle scaling).
         var drizzleFactors = [1, 2, 3, 4];
         var drizzleFactor = drizzleFactors[self.drizzleCombo.currentItem] || 1;
         if (drizzleFactor > 1 && !resampleApplied) {
            ps = ps / drizzleFactor;
         }

         self.scaleInfoLabel.text = format("(%.3f arcsec/px)", ps);

         // Use actual image dimensions for FOV and grid recommendation
         var sW = imageWidth;
         var sH = imageHeight;
         if (equipDB && camIdx >= 0 && camIdx < equipDB.cameras.length) {
            var cam2 = equipDB.cameras[camIdx];
            if (sW <= 0) sW = cam2.sensor_width;
            if (sH <= 0) sH = cam2.sensor_height;
         }
         if (sW > 0 && sH > 0) {
            var diagFov = computeDiagonalFov(sW, sH, ps);
            var rec = recommendGrid(diagFov, sW, sH);
            var fovText = "Scale: " + ps.toFixed(3) + " arcsec/px | FOV: " +
               diagFov.toFixed(1) + "\u00b0";
            if (self._solveMode !== "imagesolver") {
               fovText += " | Recommended: " + rec.cols + "x" + rec.rows;
            }
            self.fovInfoLabel.text = fovText;

            // Store recommended grid for "Recommended" button
            self._recommendedCols = rec.cols;
            self._recommendedRows = rec.rows;
         } else {
            self.fovInfoLabel.text = "";
         }
      } else {
         self.scaleInfoLabel.text = "";
         self.fovInfoLabel.text = "";
      }
   };

   // Camera selection: auto-fill pixel pitch
   this.cameraCombo.onItemSelected = function() {
      var camIdx = self.cameraCombo.currentItem - 1;
      if (equipDB && camIdx >= 0 && camIdx < equipDB.cameras.length) {
         var cam = equipDB.cameras[camIdx];
         if (cam.pixel_pitch > 0) {
            self.pixelPitchEdit.text = cam.pixel_pitch.toString();
         }
      } else {
         self.pixelPitchEdit.text = "";
      }
      updateScaleAndFov();
   };

   // Lens selection: auto-fill focal length
   this.lensCombo.onItemSelected = function() {
      var lensIdx = self.lensCombo.currentItem - 1;
      if (equipDB && lensIdx >= 0 && lensIdx < equipDB.lenses.length) {
         var lens = equipDB.lenses[lensIdx];
         if (lens.focal_length > 0) {
            self.focalLengthEdit.text = lens.focal_length.toString();
         }
      } else {
         self.focalLengthEdit.text = "";
      }
      updateScaleAndFov();
   };

   this.focalLengthEdit.onTextUpdated = function() { updateScaleAndFov(); };
   this.pixelPitchEdit.onTextUpdated = function() { updateScaleAndFov(); };
   this.drizzleCombo.onItemSelected = function() { updateScaleAndFov(); };

   var focalSizer = new HorizontalSizer;
   focalSizer.spacing = 6;
   focalSizer.add(this.focalLengthLabel);
   focalSizer.add(this.focalLengthEdit);
   focalSizer.add(this.focalLengthUnitLabel);
   focalSizer.addSpacing(12);
   focalSizer.add(this.scaleInfoLabel);
   focalSizer.addStretch();

   var pitchSizer = new HorizontalSizer;
   pitchSizer.spacing = 6;
   pitchSizer.add(this.pixelPitchLabel);
   pitchSizer.add(this.pixelPitchEdit);
   pitchSizer.add(this.pixelPitchUnitLabel);
   pitchSizer.addSpacing(12);
   pitchSizer.add(this.scaleErrorLabel);
   pitchSizer.add(this.scaleErrorEdit);
   pitchSizer.add(this.scaleErrorUnitLabel);
   pitchSizer.addStretch();

   var drizzleSizer = new HorizontalSizer;
   drizzleSizer.spacing = 6;
   drizzleSizer.add(this.drizzleLabel);
   drizzleSizer.add(this.drizzleCombo);
   drizzleSizer.addStretch();

   // ---- Object name search ----
   this.objectLabel = new Label(this);
   this.objectLabel.text = "Object:";
   this.objectLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.objectLabel.setFixedWidth(120);

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
   this.raLabel.setFixedWidth(120);

   this.raEdit = new Edit(this);
   this.raEdit.setFixedWidth(150);
   this.raEdit.toolTip = "RA hint (HH MM SS.ss or degrees). Optional";

   this.raHintLabel = new Label(this);
   this.raHintLabel.text = "(HH MM SS.ss)";

   var raSizer = new HorizontalSizer;
   raSizer.spacing = 6;
   raSizer.add(this.raLabel);
   raSizer.add(this.raEdit);
   raSizer.add(this.raHintLabel);
   raSizer.addStretch();

   this.decLabel = new Label(this);
   this.decLabel.text = "DEC:";
   this.decLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.decLabel.setFixedWidth(120);

   this.decEdit = new Edit(this);
   this.decEdit.setFixedWidth(150);
   this.decEdit.toolTip = "DEC hint (+DD MM SS.s or degrees). Optional";

   this.decHintLabel = new Label(this);
   this.decHintLabel.text = "(\u00b1DD MM SS.ss)";

   var decSizer = new HorizontalSizer;
   decSizer.spacing = 6;
   decSizer.add(this.decLabel);
   decSizer.add(this.decEdit);
   decSizer.add(this.decHintLabel);
   decSizer.addStretch();

   this.radiusLabel = new Label(this);
   this.radiusLabel.text = "Radius:";
   this.radiusLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.radiusLabel.setFixedWidth(120);

   this.radiusEdit = new Edit(this);
   this.radiusEdit.text = "10";
   this.radiusEdit.setFixedWidth(50);
   this.radiusEdit.toolTip = "Search radius (degrees)";

   this.radiusUnitLabel = new Label(this);
   this.radiusUnitLabel.text = "deg";

   var radiusSizer = new HorizontalSizer;
   radiusSizer.spacing = 6;
   radiusSizer.add(this.radiusLabel);
   radiusSizer.add(this.radiusEdit);
   radiusSizer.add(this.radiusUnitLabel);
   radiusSizer.addStretch();

   // Pre-fill RA/DEC from existing FITS header (OBJCTRA/OBJCTDEC or RA/DEC)
   if (!targetWindow.isNull) {
      var kws = targetWindow.keywords;
      var hdrRA = null, hdrDEC = null, hdrObject = null;
      for (var ki = 0; ki < kws.length; ki++) {
         var kn = kws[ki].name;
         var kv = kws[ki].value.trim().replace(/^'|'$/g, "").trim();
         if (kn === "OBJCTRA" && hdrRA === null) hdrRA = kv;
         else if (kn === "OBJCTDEC" && hdrDEC === null) hdrDEC = kv;
         else if (kn === "RA" && hdrRA === null) hdrRA = kv;
         else if (kn === "DEC" && hdrDEC === null) hdrDEC = kv;
         else if (kn === "OBJECT" && hdrObject === null) hdrObject = kv;
      }
      if (hdrRA !== null && hdrDEC !== null) {
         // OBJCTRA is HMS string, RA may be degrees
         var parsedRA = parseRAInput(hdrRA);
         var parsedDEC = parseDECInput(hdrDEC);
         if (parsedRA !== null && parsedDEC !== null) {
            this.raEdit.text = raToHMS(parsedRA);
            this.decEdit.text = decToDMS(parsedDEC);
            console.writeln("Pre-filled coordinates from FITS header: RA=" +
               raToHMS(parsedRA) + " DEC=" + decToDMS(parsedDEC));
         }
      }
      if (hdrObject !== null && hdrObject.length > 0) {
         this.objectEdit.text = hdrObject;
      }
   }

   // ---- Grid / Split mode ----
   this.gridLabel = new Label(this);
   this.gridLabel.text = "Grid:";
   this.gridLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.gridLabel.setFixedWidth(120);

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
   this.gridCombo.addItem("8x8");
   this.gridCombo.addItem("12x8");
   this.gridCombo.currentItem = 0;
   this.gridCombo.toolTip = "Image split grid (cols x rows). Splitting wide-angle images improves solve success rate";

   // Grid presets: [cols, rows]
   this.gridPresets = [
      [1, 1], [2, 2], [3, 3], [4, 4],
      [2, 1], [3, 2], [4, 3], [6, 4], [8, 6], [8, 8], [12, 8]
   ];

   // Pre-fill focal length / pixel pitch from selected camera/lens
   if (this.cameraCombo.currentItem > 0 && equipDB) {
      var initCam = equipDB.cameras[this.cameraCombo.currentItem - 1];
      if (initCam && initCam.pixel_pitch > 0) {
         this.pixelPitchEdit.text = initCam.pixel_pitch.toString();
      }
   }
   if (this.lensCombo.currentItem > 0 && equipDB) {
      var initLens = equipDB.lenses[this.lensCombo.currentItem - 1];
      if (initLens && initLens.focal_length > 0) {
         this.focalLengthEdit.text = initLens.focal_length.toString();
      }
   }
   // Trigger initial scale/FOV update
   if (this.focalLengthEdit.text.length > 0 || this.pixelPitchEdit.text.length > 0) {
      updateScaleAndFov();
   }

   this.overlapLabel = new Label(this);
   this.overlapLabel.text = "Overlap:";
   this.overlapLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.overlapLabel.setFixedWidth(120);

   this.overlapEdit = new Edit(this);
   this.overlapEdit.text = "100";
   this.overlapEdit.setFixedWidth(60);
   this.overlapEdit.toolTip = "Overlap between tiles (px)";

   this.overlapUnitLabel = new Label(this);
   this.overlapUnitLabel.text = "px";

   this._recommendedCols = 0;
   this._recommendedRows = 0;

   this.recommendButton = new PushButton(this);
   this.recommendButton.text = "Recommended";
   this.recommendButton.toolTip = "Set grid to recommended size based on FOV";
   this.recommendButton.onClick = function() {
      if (self._recommendedCols > 0 && self._recommendedRows > 0) {
         var idx = findGridPresetIndex(self.gridPresets, self._recommendedCols, self._recommendedRows);
         if (idx >= 0) {
            self.gridCombo.currentItem = idx;
            updatePreviewGrid();
         }
      }
   };

   var gridSizer = new HorizontalSizer;
   gridSizer.spacing = 6;
   gridSizer.add(this.gridLabel);
   gridSizer.add(this.gridCombo);
   gridSizer.addSpacing(6);
   gridSizer.add(this.recommendButton);
   gridSizer.addStretch();

   // Note label for ImageSolver mode (Single only)
   this.gridNoteLabel = new Label(this);
   this.gridNoteLabel.text = "* ImageSolver (built-in) supports Single mode only. Use API or Local for Split.";
   this.gridNoteLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   this.gridNoteLabel.visible = false;

   var gridNoteSizer = new HorizontalSizer;
   gridNoteSizer.spacing = 6;
   gridNoteSizer.addSpacing(120 + 6);
   gridNoteSizer.add(this.gridNoteLabel, 100);

   var fovSizer = new HorizontalSizer;
   fovSizer.spacing = 6;
   fovSizer.addSpacing(120 + 6); // Align with fields after label width
   fovSizer.add(this.fovInfoLabel, 100);

   var overlapSizer = new HorizontalSizer;
   overlapSizer.spacing = 6;
   overlapSizer.add(this.overlapLabel);
   overlapSizer.add(this.overlapEdit);
   overlapSizer.add(this.overlapUnitLabel);
   overlapSizer.addStretch();

   // ---- Skip Edge Tiles ----
   this.skipLabel = new Label(this);
   this.skipLabel.text = "Skip edges:";
   this.skipLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.skipLabel.setFixedWidth(120);

   this.skipTopSpin = new SpinBox(this);
   this.skipTopSpin.minValue = 0;
   this.skipTopSpin.maxValue = 10;
   this.skipTopSpin.value = 0;
   this.skipTopSpin.setFixedWidth(50);
   this.skipTopSpin.toolTip = "Number of tile rows to skip from the top edge";
   this.skipTopSpin.onValueUpdated = function() { updatePreviewGrid(); };

   this.skipBottomSpin = new SpinBox(this);
   this.skipBottomSpin.minValue = 0;
   this.skipBottomSpin.maxValue = 10;
   this.skipBottomSpin.value = 0;
   this.skipBottomSpin.setFixedWidth(50);
   this.skipBottomSpin.toolTip = "Number of tile rows to skip from the bottom edge";
   this.skipBottomSpin.onValueUpdated = function() { updatePreviewGrid(); };

   this.skipLeftSpin = new SpinBox(this);
   this.skipLeftSpin.minValue = 0;
   this.skipLeftSpin.maxValue = 10;
   this.skipLeftSpin.value = 0;
   this.skipLeftSpin.setFixedWidth(50);
   this.skipLeftSpin.toolTip = "Number of tile columns to skip from the left edge";
   this.skipLeftSpin.onValueUpdated = function() { updatePreviewGrid(); };

   this.skipRightSpin = new SpinBox(this);
   this.skipRightSpin.minValue = 0;
   this.skipRightSpin.maxValue = 10;
   this.skipRightSpin.value = 0;
   this.skipRightSpin.setFixedWidth(50);
   this.skipRightSpin.toolTip = "Number of tile columns to skip from the right edge";
   this.skipRightSpin.onValueUpdated = function() { updatePreviewGrid(); };

   var skipTopLabel = new Label(this);
   skipTopLabel.text = "T:";
   var skipBottomLabel = new Label(this);
   skipBottomLabel.text = "B:";
   var skipLeftLabel = new Label(this);
   skipLeftLabel.text = "L:";
   var skipRightLabel = new Label(this);
   skipRightLabel.text = "R:";

   var skipSizer = new HorizontalSizer;
   skipSizer.spacing = 4;
   skipSizer.add(this.skipLabel);
   skipSizer.add(skipTopLabel);
   skipSizer.add(this.skipTopSpin);
   skipSizer.add(skipBottomLabel);
   skipSizer.add(this.skipBottomSpin);
   skipSizer.add(skipLeftLabel);
   skipSizer.add(this.skipLeftSpin);
   skipSizer.add(skipRightLabel);
   skipSizer.add(this.skipRightSpin);
   skipSizer.addStretch();

   // ---- Downsample ----
   this.downsampleLabel = new Label(this);
   this.downsampleLabel.text = "Downsample:";
   this.downsampleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.downsampleLabel.setFixedWidth(120);

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
   this.sipCombo.addItem("2");
   this.sipCombo.addItem("3");
   this.sipCombo.addItem("4 (recommended)");
   this.sipCombo.currentItem = 2;
   this.sipCombo.toolTip = "SIP distortion correction polynomial order (tweak_order)";

   this.timeoutLabel = new Label(this);
   this.timeoutLabel.text = "Timeout:";
   this.timeoutLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.timeoutEdit = new Edit(this);
   this.timeoutEdit.text = "1";
   this.timeoutEdit.setFixedWidth(40);
   this.timeoutEdit.toolTip = "Per-tile solve timeout (minutes)";

   this.timeoutUnitLabel = new Label(this);
   this.timeoutUnitLabel.text = "min";

   var downsampleSizer = new HorizontalSizer;
   downsampleSizer.spacing = 6;
   downsampleSizer.add(this.downsampleLabel);
   downsampleSizer.add(this.downsampleCombo);
   downsampleSizer.addSpacing(12);
   downsampleSizer.add(this.sipLabel);
   downsampleSizer.add(this.sipCombo);
   downsampleSizer.addSpacing(12);
   downsampleSizer.add(this.timeoutLabel);
   downsampleSizer.add(this.timeoutEdit);
   downsampleSizer.add(this.timeoutUnitLabel);
   downsampleSizer.addStretch();

   // ---- Progress display ----
   this.progressLabel = new Label(this);
   this.progressLabel.text = "";
   this.progressLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   // ---- Buttons ----
   this._abortRequested = false;
   this._skipToMerge = false;

   this.solveButton = new PushButton(this);
   this.solveButton.text = "Solve";
   this.solveButton.icon = this.scaledResource(":/icons/execute.png");
   this.solveButton.onClick = function() {
      self.doSolve();
   };

   this.skipButton = new PushButton(this);
   this.skipButton.text = "Skip to Merge";
   this.skipButton.icon = this.scaledResource(":/icons/goto-next.png");
   this.skipButton.toolTip = "Skip remaining tiles and proceed to WCS calculation with solved tiles";
   this.skipButton.hide();
   this.skipButton.onClick = function() {
      self._skipToMerge = true;
      self.progressLabel.text = "Skipping remaining tiles...";
   };

   this.abortButton = new PushButton(this);
   this.abortButton.text = "Abort";
   this.abortButton.icon = this.scaledResource(":/icons/cancel.png");
   this.abortButton.toolTip = "Abort the current solve operation";
   this.abortButton.hide();
   this.abortButton.onClick = function() {
      var msg = new MessageBox("Abort the current solve?",
         TITLE, StdIcon_Question, StdButton_Yes, StdButton_No);
      if (msg.execute() === StdButton_Yes) {
         self._abortRequested = true;
         self.progressLabel.text = "Aborting...";
      }
   };

   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.icon = this.scaledResource(":/icons/close.png");
   this.closeButton.onClick = function() {
      if (!self._isSolving) {
         self.cancel();
      } else {
         // During solve, Close acts as abort with confirmation
         var msg = new MessageBox("Abort the current solve and close?",
            TITLE, StdIcon_Question, StdButton_Yes, StdButton_No);
         if (msg.execute() === StdButton_Yes) {
            self._abortRequested = true;
            self.progressLabel.text = "Aborting...";
         }
      }
   };

   // ---- Settings button (opens SettingsDialog) ----
   this.settingsButton = new PushButton(this);
   this.settingsButton.text = "Settings...";
   this.settingsButton.icon = this.scaledResource(":/icons/wrench.png");
   this.settingsButton.toolTip = "Configure solve mode, API key, Python environment";
   // Update UI enabled state based on solve mode
   var updateModeUI = function() {
      var isApi = (self._solveMode === "api");
      var isLocal = (self._solveMode === "local");
      var isImageSolver = (self._solveMode === "imagesolver");
      // API-only controls (disabled for Local and ImageSolver modes)
      self.downsampleCombo.enabled = isApi;
      self.sipCombo.enabled = isApi;
      // Scale error: used for scale_lower/upper in both API and Local modes
      self.scaleErrorEdit.enabled = isApi || isLocal;
      // Timeout: enabled for both API and Local modes
      self.timeoutEdit.enabled = isApi || isLocal;
      // RA/DEC radius: relevant for API mode only
      self.radiusEdit.enabled = isApi;
      // Labels
      self.downsampleLabel.enabled = isApi;
      self.sipLabel.enabled = isApi;
      self.timeoutLabel.enabled = isApi || isLocal;
      self.timeoutUnitLabel.enabled = isApi || isLocal;
      self.radiusLabel.enabled = isApi;
      self.radiusUnitLabel.enabled = isApi;
      self.scaleErrorLabel.enabled = isApi || isLocal;
      self.scaleErrorUnitLabel.enabled = isApi || isLocal;
      // ImageSolver: Single only (no split support)
      if (isImageSolver) {
         self.gridCombo.currentItem = 0; // Force "1x1 (Single)"
         self.gridCombo.enabled = false;
         self.recommendButton.visible = false;
         self.gridNoteLabel.visible = true;
         self.overlapEdit.enabled = false;
         self.overlapLabel.enabled = false;
         self.overlapUnitLabel.enabled = false;
         self.skipLabel.enabled = false;
         self.skipTopSpin.enabled = false;
         self.skipBottomSpin.enabled = false;
         self.skipLeftSpin.enabled = false;
         self.skipRightSpin.enabled = false;
      } else {
         self.gridCombo.enabled = true;
         self.recommendButton.visible = true;
         self.gridNoteLabel.visible = false;
         self.overlapEdit.enabled = true;
         self.overlapLabel.enabled = true;
         self.overlapUnitLabel.enabled = true;
         self.skipLabel.enabled = true;
         self.skipTopSpin.enabled = true;
         self.skipBottomSpin.enabled = true;
         self.skipLeftSpin.enabled = true;
         self.skipRightSpin.enabled = true;
      }
      updateScaleAndFov();
      if (typeof updatePreviewGrid === "function") updatePreviewGrid();
   };

   this.settingsButton.onClick = function() {
      var dlg = new SolverSettingsDialog(self);
      if (dlg.execute()) {
         var s = dlg.getSettings();
         self._apiKey = s.apiKey;
         self._pythonPath = s.pythonPath;
         self._scriptDir = s.scriptDir;
         self._saveTiles = s.saveTiles;
         self._tileOutputDir = s.tileOutputDir;
         // Reflect default mode from Settings onto radio buttons (only if changed)
         if (s.solveMode !== self._solveMode) {
            self._solveMode = s.solveMode;
            self.modeApiRadio.checked   = (s.solveMode === "api");
            self.modeLocalRadio.checked = (s.solveMode === "local");
            self.modeISRadio.checked    = (s.solveMode === "imagesolver");
         }
         updateModeUI();
      }
   };

   // Apply initial mode state
   updateModeUI();

   var buttonSizer = new HorizontalSizer;
   buttonSizer.spacing = 8;
   buttonSizer.add(this.settingsButton);
   buttonSizer.addStretch();
   buttonSizer.add(this.solveButton);
   buttonSizer.add(this.skipButton);
   buttonSizer.add(this.abortButton);
   buttonSizer.add(this.closeButton);

   // ---- Image Preview with Grid Overlay ----
   this.previewControl = new GridPreviewControl(this);
   this.previewControl.setMinSize(500, 500);
   this._stretchMode = "unlinked";

   // Create bitmap from active image
   if (!targetWindow.isNull) {
      var previewResult = createStretchedBitmap(
         targetWindow.mainView.image, MAX_PREVIEW_EDGE, this._stretchMode);
      this.previewControl.setBitmap(
         previewResult.bitmap, previewResult.scale,
         targetWindow.mainView.image.width, targetWindow.mainView.image.height);
   }

   // Rebuild bitmap with current stretch mode
   var rebuildPreviewBitmap = function() {
      var tw = ImageWindow.activeWindow;
      if (tw.isNull) return;
      self.cursor = new Cursor(StdCursor_Wait);
      var result = createStretchedBitmap(
         tw.mainView.image, MAX_PREVIEW_EDGE, self._stretchMode);
      self.previewControl.setBitmap(
         result.bitmap, result.scale,
         tw.mainView.image.width, tw.mainView.image.height);
      self.cursor = new Cursor(StdCursor_Arrow);
   };

   var updateStretchButtons = function() {
      self.stretchNoneButton.text = (self._stretchMode === "none") ? "\u25B6None" : "None";
      self.stretchLinkedButton.text = (self._stretchMode === "linked") ? "\u25B6Linked" : "Linked";
      self.stretchUnlinkedButton.text = (self._stretchMode === "unlinked") ? "\u25B6Unlinked" : "Unlinked";
   };

   // STF stretch buttons
   var stretchLabel = new Label(this);
   stretchLabel.text = "STF:";
   stretchLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.stretchNoneButton = new PushButton(this);
   this.stretchNoneButton.text = "None";
   this.stretchNoneButton.toolTip = "No stretch (linear)";
   this.stretchNoneButton.onClick = function() {
      if (self._stretchMode !== "none") {
         self._stretchMode = "none";
         updateStretchButtons();
         rebuildPreviewBitmap();
      }
   };

   this.stretchLinkedButton = new PushButton(this);
   this.stretchLinkedButton.text = "\u25B6Linked";
   this.stretchLinkedButton.toolTip = "Same stretch for all channels";
   this.stretchLinkedButton.onClick = function() {
      if (self._stretchMode !== "linked") {
         self._stretchMode = "linked";
         updateStretchButtons();
         rebuildPreviewBitmap();
      }
   };

   this.stretchUnlinkedButton = new PushButton(this);
   this.stretchUnlinkedButton.text = "Unlinked";
   this.stretchUnlinkedButton.toolTip = "Independent stretch per channel";
   this.stretchUnlinkedButton.onClick = function() {
      if (self._stretchMode !== "unlinked") {
         self._stretchMode = "unlinked";
         updateStretchButtons();
         rebuildPreviewBitmap();
      }
   };

   var previewToolbar = new HorizontalSizer;
   previewToolbar.spacing = 4;
   previewToolbar.add(stretchLabel);
   previewToolbar.add(this.stretchNoneButton);
   previewToolbar.add(this.stretchLinkedButton);
   previewToolbar.add(this.stretchUnlinkedButton);
   previewToolbar.addStretch();

   // Helper: update preview grid from current UI values
   var updatePreviewGrid = function() {
      var gridIdx = self.gridCombo.currentItem;
      var preset = self.gridPresets[gridIdx];
      var cols = preset ? preset[0] : 1;
      var rows = preset ? preset[1] : 1;
      var overlap = parseInt(self.overlapEdit.text) || 100;
      var skipEdges = {
         top: self.skipTopSpin.value,
         bottom: self.skipBottomSpin.value,
         left: self.skipLeftSpin.value,
         right: self.skipRightSpin.value
      };
      self.previewControl.setGrid(cols, rows, overlap, skipEdges);
   };

   // Wire grid/overlap changes to update preview
   this.gridCombo.onItemSelected = function() {
      updatePreviewGrid();
   };
   this.overlapEdit.onTextUpdated = function() {
      updatePreviewGrid();
   };

   // Set initial grid state on preview
   updatePreviewGrid();

   // ---- GroupBox: Image ----
   var imageGroup = new GroupBox(this);
   imageGroup.title = "Image";
   imageGroup.sizer = new VerticalSizer;
   imageGroup.sizer.margin = 6;
   imageGroup.sizer.spacing = 4;
   imageGroup.sizer.add(targetSizer);
   imageGroup.sizer.add(modeSizer);

   // ---- GroupBox: Equipment ----
   var equipGroup = new GroupBox(this);
   equipGroup.title = "Equipment";
   equipGroup.sizer = new VerticalSizer;
   equipGroup.sizer.margin = 6;
   equipGroup.sizer.spacing = 4;
   equipGroup.sizer.add(cameraSizer);
   equipGroup.sizer.add(lensSizer);
   equipGroup.sizer.add(focalSizer);
   equipGroup.sizer.add(pitchSizer);
   equipGroup.sizer.add(drizzleSizer);

   // ---- GroupBox: Split Settings ----
   var splitGroup = new GroupBox(this);
   splitGroup.title = "Split Settings";
   splitGroup.sizer = new VerticalSizer;
   splitGroup.sizer.margin = 6;
   splitGroup.sizer.spacing = 4;
   splitGroup.sizer.add(gridSizer);
   splitGroup.sizer.add(gridNoteSizer);
   splitGroup.sizer.add(fovSizer);
   splitGroup.sizer.add(overlapSizer);
   splitGroup.sizer.add(skipSizer);
   splitGroup.sizer.add(downsampleSizer);

   // ---- GroupBox: Coordinate Hints ----
   var coordGroup = new GroupBox(this);
   coordGroup.title = "Coordinate Hints";
   coordGroup.sizer = new VerticalSizer;
   coordGroup.sizer.margin = 6;
   coordGroup.sizer.spacing = 4;
   coordGroup.sizer.add(objectSizer);
   coordGroup.sizer.add(raSizer);
   coordGroup.sizer.add(decSizer);
   coordGroup.sizer.add(radiusSizer);

   // ---- Layout: Left = Preview, Right = Parameters ----
   var rightPanel = new VerticalSizer;
   rightPanel.spacing = 8;
   rightPanel.add(imageGroup);
   rightPanel.add(equipGroup);
   rightPanel.add(splitGroup);
   rightPanel.add(coordGroup);
   rightPanel.addStretch();

   // Right panel in a Control to set fixed width
   var rightPanelControl = new Control(this);
   rightPanelControl.sizer = rightPanel;
   rightPanelControl.setMinWidth(420);

   // Left panel: preview + toolbar
   var leftPanel = new VerticalSizer;
   leftPanel.spacing = 4;
   leftPanel.add(this.previewControl, 100);
   leftPanel.add(previewToolbar);

   var leftPanelControl = new Control(this);
   leftPanelControl.sizer = leftPanel;

   var mainHSizer = new HorizontalSizer;
   mainHSizer.spacing = 8;
   mainHSizer.add(leftPanelControl, 100);
   mainHSizer.add(rightPanelControl);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add(mainHSizer, 100);
   this.sizer.addSpacing(4);
   this.sizer.add(this.progressLabel);
   this.sizer.addSpacing(4);
   this.sizer.add(buttonSizer);

   // Prevent Escape / window close during solve — redirect to abort
   this._isSolving = false;
   this.onClose = function() {
      if (self._isSolving) {
         var msg = new MessageBox("Abort the current solve?",
            TITLE, StdIcon_Question, StdButton_Yes, StdButton_No);
         if (msg.execute() === StdButton_Yes) {
            self._abortRequested = true;
            self.progressLabel.text = "Aborting...";
         }
         return false; // Always prevent close during solve
      }
      return true;
   };

   this.adjustToContents();
   this.setMinWidth(1000);
   this.setMinHeight(600);
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

   // Mode-specific validation
   var solveMode = this._solveMode || "api";
   var apiKey = this._apiKey.trim();

   if (solveMode === "api") {
      if (apiKey.length === 0) {
         var msg = new MessageBox("API キーが設定されていません。\nSettings から API キーを設定してください。", TITLE, StdIcon_Error, StdButton_Ok);
         msg.execute();
         return;
      }
   } else if (solveMode === "local") {
      // Local mode validation
      if (this._pythonPath.length === 0 || this._scriptDir.length === 0) {
         var msg = new MessageBox("Local モードの設定が不完全です。\nSettings から Python パスとスクリプトディレクトリを設定してください。", TITLE, StdIcon_Error, StdButton_Ok);
         msg.execute();
         return;
      }
   }
   // ImageSolver mode: no additional validation needed

   var timeoutMin = parseFloat(this.timeoutEdit.text);
   var timeoutMs = (!isNaN(timeoutMin) && timeoutMin > 0) ? Math.round(timeoutMin * 60000) : 300000;

   // Build hint parameters
   var hints = {};
   hints.tweak_order = [2, 3, 4][this.sipCombo.currentItem];

   // Downsample (for single mode only; split mode uses auto-downsample per tile)
   if (this.downsampleCombo.currentItem === 1) hints.downsample_factor = 2;
   else if (this.downsampleCombo.currentItem === 2) hints.downsample_factor = 4;

   // Scale (computed from focal length and pixel pitch)
   var fl = parseFloat(this.focalLengthEdit.text);
   var pp = parseFloat(this.pixelPitchEdit.text);
   if (!isNaN(fl) && fl > 0 && !isNaN(pp) && pp > 0) {
      var nativeScale = computePixelScale(pp, fl);
      var scale = nativeScale;

      // Correct for resampled images
      var resampleApplied = false;
      var camIdxScale = this.cameraCombo.currentItem - 1;
      if (this.equipDB && camIdxScale >= 0 && camIdxScale < this.equipDB.cameras.length) {
         var camScale = this.equipDB.cameras[camIdxScale];
         var imgW = targetWindow.mainView.image.width;
         if (imgW > 0 && camScale.sensor_width > 0 && imgW !== camScale.sensor_width) {
            scale = nativeScale * (camScale.sensor_width / imgW);
            resampleApplied = true;
         }
      }

      // Apply drizzle factor only when resample correction was NOT applied
      var drizzleFactors = [1, 2, 3, 4];
      var drizzleFactor = drizzleFactors[this.drizzleCombo.currentItem] || 1;
      if (drizzleFactor > 1 && !resampleApplied) {
         scale = scale / drizzleFactor;
      }

      hints.scale_units = "arcsecperpix";
      hints.scale_est = scale;
      hints._nativeScale = nativeScale;
      var errText = this.scaleErrorEdit.text.trim();
      var errPct = parseFloat(errText);
      hints.scale_err = (!isNaN(errPct) && errPct > 0) ? errPct : 30;
      Settings.write(SETTINGS_KEY + "/pixelScale", DataType_Double, scale);
   }

   // Save camera/lens selection
   var camSaveIdx = this.cameraCombo.currentItem - 1;
   var lensSaveIdx = this.lensCombo.currentItem - 1;
   if (this.equipDB) {
      var camName = (camSaveIdx >= 0 && camSaveIdx < this.equipDB.cameras.length)
         ? this.equipDB.cameras[camSaveIdx].name : "";
      var lensName = (lensSaveIdx >= 0 && lensSaveIdx < this.equipDB.lenses.length)
         ? this.equipDB.lenses[lensSaveIdx].name : "";
      Settings.write(SETTINGS_KEY + "/camera", DataType_String, camName);
      Settings.write(SETTINGS_KEY + "/lens", DataType_String, lensName);
   }
   Settings.write(SETTINGS_KEY + "/drizzleFactor", DataType_Int32, this.drizzleCombo.currentItem);

   // RA/DEC hints
   var ra = parseRAInput(this.raEdit.text);
   var dec = parseDECInput(this.decEdit.text);
   if (ra !== null && dec !== null) {
      hints.center_ra = ra;
      hints.center_dec = dec;
      var radius = parseFloat(this.radiusEdit.text);
      hints.radius = (!isNaN(radius) && radius > 0) ? radius : 10;
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

   // _nativeScale is already set above from focal length / pixel pitch

   // Grid settings
   var gridPreset = this.gridPresets[this.gridCombo.currentItem];
   var gridX = gridPreset[0];
   var gridY = gridPreset[1];
   var isSplitMode = (gridX > 1 || gridY > 1);
   var overlap = parseInt(this.overlapEdit.text) || 100;
   var skipEdges = {
      top: this.skipTopSpin.value,
      bottom: this.skipBottomSpin.value,
      left: this.skipLeftSpin.value,
      right: this.skipRightSpin.value
   };

   // Log all parameters
   var imageWidth = targetWindow.mainView.image.width;
   var imageHeight = targetWindow.mainView.image.height;

   console.writeln("");
   console.writeln("========================================");
   console.writeln("Solve Parameters");
   console.writeln("========================================");
   console.writeln("  Solve mode:  " + (solveMode === "local" ? "Local (solve-field)" : solveMode === "imagesolver" ? "ImageSolver (built-in)" : "API (astrometry.net)"));
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
      console.writeln("  Radius:      " + (hints.radius || 10) + "\u00b0");
   } else {
      console.writeln("  RA/DEC:      (not specified - blind solve)");
   }
   console.writeln("  Grid:        " + gridX + "x" + gridY + (isSplitMode ? " (overlap " + overlap + "px)" : " (single)"));
   if (isSplitMode && (skipEdges.top > 0 || skipEdges.bottom > 0 || skipEdges.left > 0 || skipEdges.right > 0)) {
      console.writeln("  Skip edges:  T:" + skipEdges.top + " B:" + skipEdges.bottom + " L:" + skipEdges.left + " R:" + skipEdges.right);
   }
   console.writeln("  SIP Order:   " + hints.tweak_order);
   if (hints.downsample_factor) {
      console.writeln("  Downsample:  " + hints.downsample_factor + "x");
   } else {
      console.writeln("  Downsample:  Auto");
   }
   console.writeln("  Timeout:     " + (timeoutMs / 60000) + " min");
   console.writeln("========================================");
   console.writeln("");

   // Lock UI, show Abort/Skip buttons
   this._isSolving = true;
   this._abortRequested = false;
   this._skipToMerge = false;
   this.solveButton.enabled = false;
   this.solveButton.hide();
   this.abortButton.show();
   if (isSplitMode) this.skipButton.show();
   this.progressLabel.text = "Starting solve...";
   console.abortEnabled = true;
   processEvents();

   try {
      if (solveMode === "local") {
         this.doLocalSolve(targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight, skipEdges, timeoutMs);
      } else if (solveMode === "imagesolver") {
         if (isSplitMode) {
            this.doSplitSolveIS(targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight, skipEdges);
         } else {
            this.doSingleSolveIS(targetWindow, hints, imageWidth, imageHeight);
         }
      } else if (isSplitMode) {
         this.doSplitSolve(targetWindow, apiKey, hints, gridX, gridY, overlap, imageWidth, imageHeight, timeoutMs, skipEdges);
      } else {
         this.doSingleSolve(targetWindow, apiKey, hints, imageWidth, imageHeight, timeoutMs);
      }
   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      if (errMsg.indexOf("Abort") >= 0 || errMsg.indexOf("aborted by user") >= 0) {
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
   this._isSolving = false;
   this.abortButton.hide();
   this.skipButton.hide();
   this.solveButton.show();
   this.solveButton.enabled = true;
};

//----------------------------------------------------------------------------
// Single image solve (original Phase 1 flow)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSingleSolve = function(targetWindow, apiKey, hints, imageWidth, imageHeight, timeoutMs) {
   var self = this;
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
   client.timeout = timeoutMs;
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
SplitSolverDialog.prototype.doSplitSolve = function(targetWindow, apiKey, hints, gridX, gridY, overlap, imageWidth, imageHeight, timeoutMs, skipEdges) {
   var self = this;

   // API login (mode-specific setup)
   this.progressLabel.text = "Logging in to API...";
   processEvents();
   var client = new AstrometryClient(apiKey);
   client.timeout = timeoutMs;
   client.abortCheck = function() { return self._abortRequested; };
   client.skipCheck  = function() { return self._skipToMerge; };
   console.writeln("Logging in to astrometry.net...");
   if (!client.login()) throw "API login failed. Please check your API key.";
   console.writeln("  Login successful, session: " + client.session);

   // solverFactory: bind client in closure, return solveSingleTile wrapper
   var solverFactory = function(tiles) {
      return function(tile, tileHints, medianScale, expectedRaDec) {
         return solveSingleTile(client, tile, tileHints, medianScale, expectedRaDec);
      };
   };

   this.doSplitSolveCore(targetWindow, hints, gridX, gridY, overlap,
      imageWidth, imageHeight, skipEdges, solverFactory, "API",
      function() { return self._abortRequested; },
      function() { return self._skipToMerge; },
      2000, null);
};

//----------------------------------------------------------------------------
// Single image solve using ImageSolver (built-in)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSingleSolveIS = function(targetWindow, hints, imageWidth, imageHeight) {
   var self = this;

   this.progressLabel.text = "Solving with ImageSolver...";
   processEvents();

   try {
      // Create and configure ImageSolver
      var solver = new ImageSolver();
      solver.Init(targetWindow, true); // prioritize settings

      // Override metadata with our hints
      if (hints.center_ra !== undefined) solver.metadata.ra = hints.center_ra;
      if (hints.center_dec !== undefined) solver.metadata.dec = hints.center_dec;

      // Set resolution from scale hint (arcsec/px -> degrees/px)
      if (hints.scale_est) {
         solver.metadata.resolution = hints.scale_est / 3600.0;
      }

      // Ensure image dimensions
      solver.metadata.width = imageWidth;
      solver.metadata.height = imageHeight;

      // Configure output options
      solver.solverCfg.showStars = false;
      solver.solverCfg.showStarMatches = false;
      solver.solverCfg.showDistortion = false;
      solver.solverCfg.showSimplifiedSurfaces = false;
      solver.solverCfg.generateErrorImg = false;
      solver.solverCfg.generateDistortModel = false;

      // Solve
      this.progressLabel.text = "ImageSolver: detecting stars and matching catalog...";
      this.progressLabel.toolTip = "ImageSolver is running. Use the console X button to abort.";
      processEvents();

      if (!solver.SolveImage(targetWindow)) {
         // Check if abort was requested during SolveImage
         if (this._abortRequested || console.abortRequested) {
            throw "Aborted by user";
         }
         throw "ImageSolver failed. Check console for details.";
      }

      // Check abort after solve completes
      processEvents();
      if (this._abortRequested || console.abortRequested) {
         throw "Aborted by user";
      }

      // Extract WCS from the solved window
      this.progressLabel.text = "Extracting WCS...";
      this.progressLabel.toolTip = "";
      processEvents();

      var isWcs = extractWcsFromMetadata(solver.metadata);
      if (!isWcs || isWcs.crval1 === undefined) {
         throw "Failed to extract WCS from solved image.";
      }

      // Convert to our bottom-up wcsResult format
      var wcsResult = convertISwcsToBU(isWcs);

      // Get calibration info for display
      var resolvedScale = solver.metadata.resolution ? solver.metadata.resolution * 3600.0 : 0;
      var calibration = {
         ra: isWcs.crval1,
         dec: isWcs.crval2,
         pixscale: resolvedScale,
         orientation: 0
      };
      if (isWcs.cd2_1 !== undefined && isWcs.cd2_2 !== undefined) {
         calibration.orientation = Math.atan2(isWcs.cd2_1 || 0, isWcs.cd2_2 || 0) * 180.0 / Math.PI;
      }

      console.writeln("ImageSolver result: RA=" + calibration.ra.toFixed(4) +
         " Dec=" + calibration.dec.toFixed(4) +
         " scale=" + calibration.pixscale.toFixed(4) + " arcsec/px" +
         " rotation=" + calibration.orientation.toFixed(2) + " deg");

      // ImageSolver already wrote a complete astrometric solution via
      // SaveKeywords/SaveProperties/regenerateAstrometricSolution.
      // Do NOT overwrite it — SPFC and other tools depend on the full
      // solution format that ImageSolver produces (including proper
      // SplineWorldTransformation with computed coefficients).
      // Just display the result coordinates.
      console.writeln("");
      console.writeln("<b>Applying WCS to image: " + targetWindow.mainView.id + "</b>");
      console.writeln("  CRVAL = (" + isWcs.crval1.toFixed(6) + ", " + isWcs.crval2.toFixed(6) + ")");
      console.writeln("  CRPIX = (" + isWcs.crpix1.toFixed(2) + ", " + isWcs.crpix2.toFixed(2) + ")");
      console.writeln("  CD = [[" + (isWcs.cd1_1 || 0).toExponential(6) + ", " + (isWcs.cd1_2 || 0).toExponential(6) + "],");
      console.writeln("        [" + (isWcs.cd2_1 || 0).toExponential(6) + ", " + (isWcs.cd2_2 || 0).toExponential(6) + "]]");

      // Display image coordinates using IS WCS (F-coordinates → our BU convention)
      var wcsObj = {
         crval1: wcsResult.crval1, crval2: wcsResult.crval2,
         crpix1: wcsResult.crpix1, crpix2: wcsResult.crpix2,
         cd1_1: wcsResult.cd[0][0], cd1_2: wcsResult.cd[0][1],
         cd2_1: wcsResult.cd[1][0], cd2_2: wcsResult.cd[1][1],
         sip: wcsResult.sip
      };
      displayImageCoordinates(wcsObj, imageWidth, imageHeight);

      this.progressLabel.text = "Solve completed successfully!";
      console.writeln("");
      console.writeln("Solve completed successfully!");

   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      console.writeln("ERROR: " + errMsg);
      this.progressLabel.text = "Error: " + errMsg;
      var msg = new MessageBox(errMsg, TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
   }
};

//----------------------------------------------------------------------------
// Split image solve using ImageSolver (built-in)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSplitSolveIS = function(targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight, skipEdges) {
   var self = this;

   // solverFactory: return solveSingleTileIS directly (no setup needed)
   var solverFactory = function(tiles) {
      return solveSingleTileIS;
   };

   this.doSplitSolveCore(targetWindow, hints, gridX, gridY, overlap,
      imageWidth, imageHeight, skipEdges, solverFactory, "ImageSolver",
      function() { return self._abortRequested; },
      function() { return self._skipToMerge; },
      0, null);
};

//----------------------------------------------------------------------------
// doSplitSolveCore
//
// Unified split-solve pipeline shared by all solver modes (API / IS / Local).
// The only mode-specific part is solverFactory, which receives the tile array
// after splitting and returns a solverFn:
//
//   solverFactory(tiles) -> solverFn
//   solverFn(tile, tileHints, medianScale, expectedRaDec) -> bool
//
// Optional debugFixturePath: if set, writes per-tile snapshot JSON after
// solveWavefront() completes (used to generate integration test fixtures).
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doSplitSolveCore = function(
      targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight,
      skipEdges, solverFactory, modeName, abortCheckFn, skipCheckFn, rateLimitMs,
      debugFixturePath) {
   var self = this;
   var tiles = [];
   var invalidated = 0;

   try {
      // 1. Split image into tiles
      this.progressLabel.text = "Splitting image into tiles... (" + gridX + "x" + gridY + ")";
      processEvents();
      console.writeln("");
      console.writeln("<b>Splitting image into " + gridX + "x" + gridY + " tiles (overlap=" + overlap + "px)</b>");

      tiles = splitImageToTiles(targetWindow, gridX, gridY, overlap, skipEdges);
      if (tiles.length === 0) throw "Tile splitting failed.";

      // 1b. Optionally copy tile FITS to a user-specified output directory
      if (this._saveTiles && this._tileOutputDir.length > 0) {
         try { File.createDirectory(this._tileOutputDir); } catch (e) { /* already exists */ }
         for (var dti = 0; dti < tiles.length; dti++) {
            var src = tiles[dti].filePath;
            var dst = this._tileOutputDir + "/tile_" + tiles[dti].row + "_" + tiles[dti].col + ".fits";
            File.copyFile(dst, src);
         }
         console.writeln("Tile files saved to: " + this._tileOutputDir + " (" + tiles.length + " files)");
      }

      // 2. Compute per-tile RA/DEC hints
      if (hints.center_ra !== undefined && hints.center_dec !== undefined && hints.scale_est) {
         computeTileHints(tiles, hints.center_ra, hints.center_dec,
            hints.scale_est, imageWidth, imageHeight, hints._projection || "rectilinear");
         console.writeln("Per-tile RA/DEC hints computed (" + (hints._projection || "rectilinear") + " projection):");
         for (var ti = 0; ti < tiles.length; ti++) {
            console.writeln("  Tile [" + tiles[ti].col + "," + tiles[ti].row + "]: RA=" +
               raToHMS(tiles[ti].hintRA) + " DEC=" + decToDMS(tiles[ti].hintDEC));
         }
      }

      // 3. Obtain solverFn from factory (mode-specific setup, e.g. Python batch call)
      var solverFn = solverFactory(tiles);

      // 4. Wavefront solve
      console.writeln("");
      console.writeln("<b>Solving " + tiles.length + " tiles (" + modeName + ")...</b>");

      var successCount = solveWavefront(null, tiles, hints, imageWidth, imageHeight, gridX, gridY,
         function(message) {
            self.progressLabel.text = message;
            processEvents();
         },
         solverFn, abortCheckFn, skipCheckFn, rateLimitMs);

      if (successCount < 2) {
         throw "Too few tiles solved (" + successCount + "/" + tiles.length + "). At least 2 required.";
      }

      // 5. Write debug fixture if requested
      if (debugFixturePath) {
         try {
            var fixtureData = {
               imageWidth: imageWidth, imageHeight: imageHeight,
               gridX: gridX, gridY: gridY,
               hints: {
                  centerRA: hints.center_ra, centerDEC: hints.center_dec,
                  scaleEst: hints.scale_est, projection: hints._projection || "rectilinear"
               },
               tiles: []
            };
            for (var fi = 0; fi < tiles.length; fi++) {
               var ft = tiles[fi];
               fixtureData.tiles.push({
                  row: ft.row, col: ft.col,
                  offsetX: ft.offsetX, offsetY: ft.offsetY,
                  tileWidth: ft.tileWidth, tileHeight: ft.tileHeight,
                  scaleFactor: ft.scaleFactor || 1.0,
                  hintRA: ft.hintRA, hintDEC: ft.hintDEC,
                  scaleLower: ft.scaleLower, scaleUpper: ft.scaleUpper,
                  status: ft.status,
                  wcs: ft.wcs || null,
                  calibration: ft.calibration || null
               });
            }
            File.writeTextFile(debugFixturePath, JSON.stringify(fixtureData, null, 2));
            console.writeln("Debug fixture written: " + debugFixturePath);
         } catch (fe) {
            console.warningln("Failed to write debug fixture: " + fe.toString());
         }
      }

      // 6. Overlap validation
      this.progressLabel.text = "Validating overlap...";
      processEvents();

      var overlapTolerance = Math.max(5.0, (hints.scale_est || 5.0) * 3);
      invalidated = validateOverlap(tiles, imageWidth, imageHeight, overlapTolerance);
      if (invalidated > 0) {
         successCount -= invalidated;
         console.writeln(invalidated + " tiles invalidated by overlap check");
         if (successCount < 2) {
            throw "Too few valid tiles after overlap validation (" + successCount + "/" + tiles.length + ").";
         }
      }

      // 7. Merge WCS solutions
      this.progressLabel.text = "Merging WCS solutions...";
      processEvents();
      console.writeln("");
      console.writeln("<b>Merging WCS solutions from " + successCount + " tiles...</b>");

      var wcsResult = mergeWcsSolutions(tiles, imageWidth, imageHeight);
      if (!wcsResult) throw "WCS merging failed.";

      // 8. Display banner and tile grid
      console.writeln("");
      console.writeln("    .       *           .       *       .           *");
      console.writeln("        .       .   *       .       .       *");
      console.writeln("  +=========================================+");
      console.writeln("  |                                         |");
      console.writeln("  |     * SPLIT IMAGE SOLVER - SOLVED! *    |");
      console.writeln("  |                                         |");
      console.writeln("  +=========================================+");
      console.writeln("        *       .           *       .       .");
      console.writeln("    .       .       *   .       *       .       *");
      console.writeln("");
      console.writeln("<b>Result:</b> " + successCount + "/" + tiles.length + " tiles solved" +
         (invalidated > 0 ? " (" + invalidated + " invalidated)" : "") +
         ", RMS: " + wcsResult.rms_arcsec.toFixed(2) + " arcsec");
      console.writeln("");
      console.writeln("<b>Tile solve grid (" + gridX + "x" + gridY + "):</b>");
      printTileGrid(tiles, gridX, gridY);
      console.writeln("  (\u25cb=solved, \u00d7=failed, \u2014=skipped)");

      // 9. Apply unified WCS
      this.applyAndDisplay(targetWindow, wcsResult, imageWidth, imageHeight, null);

      // 10. Summary
      var msg = new MessageBox("Split solve (" + modeName + ") completed.\n\n" +
         "Tiles: " + successCount + "/" + tiles.length + " succeeded" +
         (invalidated > 0 ? " (" + invalidated + " invalidated)" : "") + "\n" +
         "RMS: " + wcsResult.rms_arcsec.toFixed(2) + " arcsec",
         TITLE, StdIcon_Information, StdButton_Ok);
      msg.execute();

   } catch (e) {
      var errMsg = (typeof e === "string") ? e : e.toString();
      console.writeln("ERROR: " + errMsg);
      this.progressLabel.text = "Error: " + errMsg;
      var msg = new MessageBox(errMsg, TITLE, StdIcon_Error, StdButton_Ok);
      msg.execute();
   }
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
   if (wcsResult.rms_arcsec !== undefined) {
      console.writeln("  RMS residual: " + wcsResult.rms_arcsec.toFixed(2) + " arcsec");
   }

   // Apply WCS: FITS keywords (including SIP distortion) + PCL properties.
   // SplineWorldTransformation control points are NOT written here because
   // regenerateAstrometricSolution() cannot properly compute spline coefficients
   // from our control points, causing SPFC to fail. The SIP polynomial in FITS
   // keywords provides sufficient distortion correction for SPCC/SPFC.
   targetWindow.mainView.beginProcess(UndoFlag_Keywords);
   applyWCSToImage(targetWindow, wcsResult, imageWidth, imageHeight);
   targetWindow.regenerateAstrometricSolution();
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

//----------------------------------------------------------------------------
// Local solve (Python backend)
//----------------------------------------------------------------------------
SplitSolverDialog.prototype.doLocalSolve = function(targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight, skipEdges, timeoutMs) {
   var self = this;
   var pythonPath = this._pythonPath;
   var scriptDir = this._scriptDir;
   var scriptPath = scriptDir + "/python/main.py";
   if (!timeoutMs || timeoutMs <= 0) timeoutMs = 30 * 60 * 1000;

   // Per-tile timeout in seconds (same semantics as API mode)
   var timeoutPerTile = Math.max(30, Math.round(timeoutMs / 1000));
   var pythonDir = File.extractDirectory(pythonPath);
   var pathEnv = quotePath(pythonDir) + ":/opt/homebrew/bin:/usr/local/bin:$PATH";

   // solverFactory: per-tile Python --solve-single-tile invocation.
   // Each call solves one tile using wavefront-refined hints from tileHints.
   var solverFactory = function(tiles) {
      return function(tile, tileHints, medianScale, expectedRaDec) {
         var resultPath = File.systemTempDirectory + "/sis_tile_result_" + tile.row + "_" + tile.col + ".json";
         var stderrFile = File.systemTempDirectory + "/sis_tile_stderr_" + tile.row + "_" + tile.col + ".txt";

         if (File.exists(resultPath)) try { File.remove(resultPath); } catch (e) {}
         if (File.exists(stderrFile)) try { File.remove(stderrFile); } catch (e) {}

         // Build CLI command using tileHints (wavefront-refined)
         var raHint = tileHints.center_ra;
         var decHint = tileHints.center_dec;
         var scaleLower = tileHints.scale_lower;
         var scaleUpper = tileHints.scale_upper;

         var shellCmd = "export PATH=" + pathEnv + "; "
            + quotePath(pythonPath) + " " + quotePath(scriptPath)
            + " --solve-single-tile"
            + " --tile-path " + quotePath(tile.filePath)
            + " --result-file " + quotePath(resultPath)
            + " --timeout-per-tile " + timeoutPerTile;

         if (raHint !== undefined && raHint !== null && decHint !== undefined && decHint !== null) {
            shellCmd += " --ra-hint " + raHint + " --dec-hint " + decHint;
         }
         if (scaleLower !== undefined && scaleLower !== null && scaleUpper !== undefined && scaleUpper !== null) {
            shellCmd += " --scale-lower " + scaleLower + " --scale-upper " + scaleUpper;
         }

         shellCmd += " 2>> " + quotePath(stderrFile);

         self.progressLabel.text = "Solving tile [" + tile.row + "][" + tile.col + "]...";
         processEvents();

         var P = new ExternalProcess;
         P.workingDirectory = scriptDir;
         P.start("/bin/sh", ["-c", shellCmd]);

         // Poll with abort support and stderr display
         var pollIntervalMs = 500;
         var elapsed = 0;
         var jsWatchdogMs = (timeoutPerTile + 30) * 1000;
         var lastStderrSize = 0;

         while (elapsed < jsWatchdogMs) {
            if (P.waitForFinished(pollIntervalMs)) break;
            processEvents();

            if (self._abortRequested || console.abortRequested) {
               console.warningln("<b>Abort requested. Killing Python process...</b>");
               P.kill();
               throw "Python tile solver aborted by user.";
            }

            try {
               if (File.exists(stderrFile)) {
                  var currentStderr = File.readTextFile(stderrFile);
                  if (currentStderr.length > lastStderrSize) {
                     var newOutput = currentStderr.substring(lastStderrSize).trim();
                     if (newOutput.length > 0) {
                        var newLines = newOutput.split("\n");
                        for (var li = 0; li < newLines.length; li++) {
                           console.writeln("[PYTHON] " + newLines[li]);
                        }
                        console.flush();
                     }
                     lastStderrSize = currentStderr.length;
                  }
               }
            } catch (e) {}

            elapsed += pollIntervalMs;
         }

         if (elapsed >= jsWatchdogMs && !P.waitForFinished(0)) {
            P.kill();
            console.writeln("  [" + tile.row + "][" + tile.col + "] Python timed out (" + timeoutPerTile + "s)");
            return false;
         }
         if (P.exitCode !== 0) {
            console.writeln("  [" + tile.row + "][" + tile.col + "] Python failed (exit " + P.exitCode + ")");
            return false;
         }

         // Parse result JSON
         if (!File.exists(resultPath)) {
            console.writeln("  [" + tile.row + "][" + tile.col + "] no result file");
            return false;
         }
         var r;
         try {
            r = JSON.parse(File.readTextFile(resultPath));
         } catch (e) {
            console.writeln("  [" + tile.row + "][" + tile.col + "] JSON parse error: " + e.toString());
            return false;
         }
         // Cleanup temp files
         try { File.remove(resultPath); } catch (e) {}
         try { File.remove(stderrFile); } catch (e) {}

         if (!r.success) return false;

         // Reverse downsample and apply tile offset (top-down convention)
         var sf = tile.scaleFactor || 1.0;
         tile.wcs = {
            crval1: r.crval1, crval2: r.crval2,
            crpix1: (r.crpix1 / sf) + tile.offsetX,
            crpix2: (r.crpix2 / sf) + tile.offsetY,
            cd1_1:  r.cd1_1 * sf, cd1_2: r.cd1_2 * sf,
            cd2_1:  r.cd2_1 * sf, cd2_2: r.cd2_2 * sf
         };
         if (r.sip_order && r.sip_a && r.sip_b) {
            tile.wcs.sip = { order: r.sip_order, a: r.sip_a, b: r.sip_b };
         }
         tile.calibration = { pixscale: r.pixel_scale, ra: r.crval1, dec: r.crval2 };
         return true;
      };
   };

   this.doSplitSolveCore(targetWindow, hints, gridX, gridY, overlap,
      imageWidth, imageHeight, skipEdges, solverFactory, "Local",
      function() { return self._abortRequested; },
      function() { return self._skipToMerge; },
      0, null);
};

// ---------------------------------------------------------------------------
// _doLocalSolve_legacy (旧実装を保持: Python フルパイプライン呼び出し)
// 将来的に削除予定。Single (1x1) モード等で従来の Python WCSIntegrator が
// 必要になった場合の参照用として残す。
// ---------------------------------------------------------------------------
SplitSolverDialog.prototype._doLocalSolve_legacy = function(targetWindow, hints, gridX, gridY, overlap, imageWidth, imageHeight, skipEdges) {
   var self = this;
   var pythonPath = this._pythonPath;
   var scriptDir = this._scriptDir;
   var scriptPath = scriptDir + "/python/main.py";

   // Save current view to temporary XISF
   var tmpInput = File.systemTempDirectory + "/split_solver_input.xisf";
   var tmpOutput = File.systemTempDirectory + "/split_solver_output.xisf";
   var resultFile = File.systemTempDirectory + "/split_solver_result.json";

   console.writeln("Saving current view to temporary file...");
   this.progressLabel.text = "Saving image...";
   processEvents();

   if (File.exists(tmpInput)) try { File.remove(tmpInput); } catch (e) {}
   if (File.exists(resultFile)) try { File.remove(resultFile); } catch (e) {}

   var xisfFormat = new FileFormat("XISF", false, true);
   var writer = new FileFormatInstance(xisfFormat);
   if (!writer.create(tmpInput))
      throw new Error("Failed to create temp file: " + tmpInput);
   writer.keywords = targetWindow.keywords;
   var imgDesc = new ImageDescription;
   imgDesc.bitsPerSample = 32;
   imgDesc.ieeefpSampleFormat = true;
   if (!writer.setOptions(imgDesc))
      throw new Error("Failed to set image options for temp file");
   if (!writer.writeImage(targetWindow.mainView.image))
      throw new Error("Failed to write image data to temp file");
   writer.close();
   console.writeln("Saved: " + tmpInput);

   // Build command arguments
   var grid = gridX + "x" + gridY;
   var args = [
      pythonPath, scriptPath,
      "--input", tmpInput,
      "--output", tmpOutput,
      "--grid", grid,
      "--overlap", overlap.toString(),
      "--json-output",
      "--result-file", resultFile
   ];

   if (hints.center_ra !== undefined && hints.center_dec !== undefined) {
      args.push("--ra");
      args.push(hints.center_ra.toString());
      args.push("--dec");
      args.push(hints.center_dec.toString());
   }
   // Pass focal length and pixel pitch from UI input fields
   var localFl = parseFloat(this.focalLengthEdit.text);
   var localPp = parseFloat(this.pixelPitchEdit.text);
   if (!isNaN(localPp) && localPp > 0) {
      args.push("--pixel-pitch");
      args.push(localPp.toString());
   }
   if (!isNaN(localFl) && localFl > 0) {
      args.push("--focal-length");
      args.push(localFl.toString());
   }
   if (hints._projection && hints._projection !== "rectilinear") {
      args.push("--lens-type");
      args.push(hints._projection);
   }

   // Skip edges
   if (skipEdges && (skipEdges.top > 0 || skipEdges.bottom > 0 || skipEdges.left > 0 || skipEdges.right > 0)) {
      args.push("--skip-edges");
      args.push(skipEdges.top + "," + skipEdges.bottom + "," + skipEdges.left + "," + skipEdges.right);
   }

   // Build shell command with proper PATH
   var cmdParts = [];
   for (var i = 0; i < args.length; i++) {
      cmdParts.push(quotePath(args[i]));
   }

   var pythonDir = File.extractDirectory(pythonPath);
   var pathPrefix = "export PATH="
      + quotePath(pythonDir)
      + ":/opt/homebrew/bin:/usr/local/bin:$PATH; ";

   var stdoutFile = File.systemTempDirectory + "/split_solver_stdout.log";
   var stderrFile = File.systemTempDirectory + "/split_solver_stderr.log";
   var shellCmd = pathPrefix + cmdParts.join(" ")
      + " > " + quotePath(stdoutFile)
      + " 2> " + quotePath(stderrFile);

   console.writeln("Executing Python solver...");
   console.writeln("Command: " + shellCmd);
   this.progressLabel.text = "Running Python solver...";
   processEvents();

   var P = new ExternalProcess;
   P.workingDirectory = scriptDir;
   P.start("/bin/sh", ["-c", shellCmd]);

   // Poll for completion with abort support
   var timeoutMs = 30 * 60 * 1000;
   var pollIntervalMs = 500;
   var elapsed = 0;
   var aborted = false;
   var lastStderrSize = 0;

   while (elapsed < timeoutMs) {
      if (P.waitForFinished(pollIntervalMs)) {
         break;
      }
      processEvents();

      if (self._abortRequested || console.abortRequested) {
         console.writeln("");
         console.warningln("<b>Abort requested. Killing process...</b>");
         P.kill();
         aborted = true;
         break;
      }

      // Show stderr output in real-time
      try {
         if (File.exists(stderrFile)) {
            var currentStderr = File.readTextFile(stderrFile);
            if (currentStderr.length > lastStderrSize) {
               var newOutput = currentStderr.substring(lastStderrSize).trim();
               if (newOutput.length > 0) {
                  var newLines = newOutput.split("\n");
                  for (var li = 0; li < newLines.length; li++) {
                     console.writeln("[PYTHON] " + newLines[li]);
                  }
                  console.flush();
                  // Update progress with last line
                  self.progressLabel.text = newLines[newLines.length - 1];
                  processEvents();
               }
               lastStderrSize = currentStderr.length;
            }
         }
      } catch (e) {
         // Ignore file read errors during write
      }

      elapsed += pollIntervalMs;
   }

   if (aborted) {
      try { if (File.exists(stdoutFile)) File.remove(stdoutFile); } catch (e) {}
      try { if (File.exists(stderrFile)) File.remove(stderrFile); } catch (e) {}
      try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
      try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
      throw new Error("Process aborted by user");
   }

   if (elapsed >= timeoutMs && !P.waitForFinished(0)) {
      P.kill();
      try { if (File.exists(stdoutFile)) File.remove(stdoutFile); } catch (e) {}
      try { if (File.exists(stderrFile)) File.remove(stderrFile); } catch (e) {}
      try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
      try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
      throw new Error("Process timed out after 30 minutes");
   }

   // Read output from temp files
   var stdout = "";
   var stderr = "";
   try {
      if (File.exists(stdoutFile)) {
         stdout = File.readTextFile(stdoutFile).trim();
         File.remove(stdoutFile);
      }
   } catch (e) {}
   try {
      if (File.exists(stderrFile)) {
         stderr = File.readTextFile(stderrFile).trim();
         File.remove(stderrFile);
      }
   } catch (e) {}

   // Show remaining stderr
   if (stderr.length > lastStderrSize) {
      var remainingStderr = stderr.substring(lastStderrSize).trim();
      if (remainingStderr.length > 0) {
         var stderrLines = remainingStderr.split("\n");
         for (var si = 0; si < stderrLines.length; si++) {
            console.writeln("[PYTHON] " + stderrLines[si]);
         }
      }
   }

   if (P.exitCode !== 0) {
      console.warningln("Process exited with code: " + P.exitCode);
      if (stdout.length > 0) {
         try {
            var errResult = JSON.parse(stdout);
            if (errResult.error) {
               try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
               try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
               throw new Error("Solver failed: " + errResult.error);
            }
         } catch (e) {
            if (e.message.indexOf("Solver failed") === 0) throw e;
         }
      }
      try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
      try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
      throw new Error("Solver process exited with code " + P.exitCode);
   }

   // Parse result JSON (result-file first, stdout fallback)
   var result = null;

   if (File.exists(resultFile)) {
      try {
         var resultJson = File.readTextFile(resultFile).trim();
         result = JSON.parse(resultJson);
      } catch (e) {
         console.warningln("Failed to parse result file: " + e.message);
      }
      try { File.remove(resultFile); } catch (e) {}
   }

   if (!result && stdout.length > 0) {
      var lines = stdout.split("\n");
      for (var j = lines.length - 1; j >= 0; j--) {
         var line = lines[j].trim();
         if (line.length > 0 && line.charAt(0) === '{') {
            try {
               result = JSON.parse(line);
               break;
            } catch (e) {
               continue;
            }
         }
      }
   }

   if (!result || !result.success) {
      try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
      try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
      throw new Error("Solver completed but reported failure");
   }

   // Display results
   console.writeln("");
   console.writeln("    .       *           .       *       .           *");
   console.writeln("        .       .   *       .       .       *");
   console.writeln("  +=========================================+");
   console.writeln("  |                                         |");
   console.writeln("  |     * SPLIT IMAGE SOLVER - SOLVED! *    |");
   console.writeln("  |                                         |");
   console.writeln("  +=========================================+");
   console.writeln("        *       .           *       .       .");
   console.writeln("    .       .       *   .       *       .       *");
   console.writeln("");

   if (result.equipment) {
      try {
         var eq = result.equipment;
         var eqLines = [];
         if (eq.camera) eqLines.push("Camera: " + eq.camera);
         if (eq.lens) eqLines.push("Lens: " + eq.lens);
         if (eq.focal_length_mm) eqLines.push("FL: " + eq.focal_length_mm + "mm");
         if (eq.pixel_pitch_um) eqLines.push("Pitch: " + eq.pixel_pitch_um + "um");
         if (eqLines.length > 0) {
            console.writeln("<b>Equipment:</b> " + eqLines.join(" | "));
         }
      } catch (e1) {}
   }

   try {
      var summary = "<b>Result:</b> "
         + result.tiles_solved + "/" + result.tiles_total + " tiles solved";
      if (result.wcs) {
         summary += ", CRVAL=(" + result.wcs.crval1.toFixed(4)
            + ", " + result.wcs.crval2.toFixed(4) + ")";
         if (result.wcs.pixel_scale) {
            summary += ", " + result.wcs.pixel_scale.toFixed(2) + "\"/px";
         }
      }
      console.writeln(summary);
   } catch (e2) {
      console.writeln("<b>Result:</b> Solver completed");
   }

   // Tile grid display
   if (result.tile_grid && result.grid) {
      try {
         var rows = result.grid.rows;
         var cols = result.grid.cols;
         var tileGrid = result.tile_grid;
         var header = "    ";
         for (var c = 0; c < cols; c++) { header += c + " "; }
         console.writeln("");
         console.writeln("<b>Tile solve grid (" + cols + "x" + rows + "):</b>");
         console.writeln(header);
         for (var r = 0; r < rows; r++) {
            var gridLine = (r < 10 ? " " : "") + r + "  ";
            for (var gc = 0; gc < cols; gc++) {
               var cell = tileGrid[r][gc];
               if (cell === "O") gridLine += "\u25cb ";       // ○ success
               else if (cell === "-") gridLine += "  ";       //   skip edge excluded
               else gridLine += "\u00d7 ";                    // × failed
            }
            console.writeln(gridLine);
         }
         console.writeln("  (\u25cb=solved, \u00d7=failed, \u2014=skipped)");
      } catch (e3) {}
   }

   // Coordinate display
   if (result.coordinates) {
      try {
         var coords = result.coordinates;
         console.writeln("");
         console.writeln("<b>Image coordinates:</b>");
         if (coords.center)
            console.writeln("  Center ........ RA: " + raToHMS(coords.center.ra_deg) + "  Dec: " + decToDMS(coords.center.dec_deg));
         if (coords.top_left)
            console.writeln("  Top-Left ...... RA: " + raToHMS(coords.top_left.ra_deg) + "  Dec: " + decToDMS(coords.top_left.dec_deg));
         if (coords.top_right)
            console.writeln("  Top-Right ..... RA: " + raToHMS(coords.top_right.ra_deg) + "  Dec: " + decToDMS(coords.top_right.dec_deg));
         if (coords.bottom_left)
            console.writeln("  Bottom-Left ... RA: " + raToHMS(coords.bottom_left.ra_deg) + "  Dec: " + decToDMS(coords.bottom_left.dec_deg));
         if (coords.bottom_right)
            console.writeln("  Bottom-Right .. RA: " + raToHMS(coords.bottom_right.ra_deg) + "  Dec: " + decToDMS(coords.bottom_right.dec_deg));
         var fovParts = [];
         if (coords.width_fov_deg)
            fovParts.push(coords.width_fov_deg.toFixed(2) + " x " + coords.height_fov_deg.toFixed(2));
         if (coords.diagonal_fov_deg)
            fovParts.push("diagonal " + coords.diagonal_fov_deg.toFixed(2));
         if (fovParts.length > 0)
            console.writeln("  Field of view . " + fovParts.join(", ") + " deg");
         if (result.wcs && result.wcs.pixel_scale)
            console.writeln("  Pixel scale ... " + result.wcs.pixel_scale.toFixed(2) + " arcsec/px");
      } catch (e4) {}
   }

   // Apply WCS to active window
   this.progressLabel.text = "Applying WCS...";
   processEvents();
   console.writeln("");
   console.writeln("<b>Applying WCS keywords to active window...</b>");

   if (result.wcs_keywords) {
      var existingKw = targetWindow.keywords;
      var cleanedKw = [];
      for (var ki = 0; ki < existingKw.length; ki++) {
         if (!isWCSKeyword(existingKw[ki].name)) {
            cleanedKw.push(existingKw[ki]);
         }
      }

      var wcsKeys = result.wcs_keywords;
      var addedCount = 0;
      for (var key in wcsKeys) {
         if (wcsKeys.hasOwnProperty(key)) {
            cleanedKw.push(makeFITSKeyword(key, wcsKeys[key]));
            addedCount++;
         }
      }

      targetWindow.keywords = cleanedKw;
      console.writeln(format("Added %d WCS keywords.", addedCount));

      // Write PCL:AstrometricSolution properties for SPFC compatibility
      // Local mode: wcs object has crval1/crval2 only; crpix/cd come from wcs_keywords
      var pcrval1 = wcsKeys["CRVAL1"];
      var pcrval2 = wcsKeys["CRVAL2"];
      var pcrpix1 = wcsKeys["CRPIX1"];
      var pcrpix2 = wcsKeys["CRPIX2"];
      if (pcrval1 !== undefined && pcrpix1 !== undefined) {
         var view = targetWindow.mainView;
         var attrs = PropertyAttribute_Storable | PropertyAttribute_Permanent;

         // Remove existing SplineWorldTransformation properties
         var existingProps = view.properties;
         for (var pi = 0; pi < existingProps.length; pi++) {
            if (existingProps[pi].indexOf("SplineWorldTransformation") >= 0) {
               view.deleteProperty(existingProps[pi]);
            }
         }
         view.deleteProperty("Transformation_ImageToProjection");
         view.deleteProperty("PCL:AstrometricSolution:Information");

         view.setPropertyValue("PCL:AstrometricSolution:ProjectionSystem", "Gnomonic", PropertyType_String8, attrs);
         view.setPropertyValue("PCL:AstrometricSolution:ReferenceCelestialCoordinates",
            new Vector([pcrval1, pcrval2]), PropertyType_F64Vector, attrs);

         var refImgX = pcrpix1 - 1;
         var refImgY = pcrpix2;
         view.setPropertyValue("PCL:AstrometricSolution:ReferenceImageCoordinates",
            new Vector([refImgX, refImgY]), PropertyType_F64Vector, attrs);

         var cd11 = wcsKeys["CD1_1"] || 0, cd12 = wcsKeys["CD1_2"] || 0;
         var cd21 = wcsKeys["CD2_1"] || 0, cd22 = wcsKeys["CD2_2"] || 0;
         var ltMatrix = new Matrix(2, 2);
         ltMatrix.at(0, 0, cd11); ltMatrix.at(0, 1, cd12);
         ltMatrix.at(1, 0, cd21); ltMatrix.at(1, 1, cd22);
         view.setPropertyValue("PCL:AstrometricSolution:LinearTransformationMatrix", ltMatrix, PropertyType_F64Matrix, attrs);

         view.setPropertyValue("PCL:AstrometricSolution:ReferenceNativeCoordinates",
            new Vector([0, 90]), PropertyType_F64Vector, attrs);
         var plon = (pcrval2 < 90) ? 180 : 0;
         view.setPropertyValue("PCL:AstrometricSolution:CelestialPoleNativeCoordinates",
            new Vector([plon, 90]), PropertyType_F64Vector, attrs);

         view.setPropertyValue("Observation:Center:RA", pcrval1, PropertyType_Float64, attrs);
         view.setPropertyValue("Observation:Center:Dec", pcrval2, PropertyType_Float64, attrs);
         view.setPropertyValue("Observation:CelestialReferenceSystem", "ICRS", PropertyType_String8, attrs);
         view.setPropertyValue("Observation:Equinox", 2000.0, PropertyType_Float64, attrs);

         view.setPropertyValue("PCL:AstrometricSolution:CreationTime", (new Date).toISOString(), PropertyType_TimePoint, attrs);
         var creatorApp = format("PixInsight %s%d.%d.%d",
            CoreApplication.versionLE ? "LE " : "",
            CoreApplication.versionMajor, CoreApplication.versionMinor, CoreApplication.versionRelease);
         view.setPropertyValue("PCL:AstrometricSolution:CreatorApplication", creatorApp, PropertyType_String, attrs);
         view.setPropertyValue("PCL:AstrometricSolution:CreatorModule", "SplitImageSolver " + VERSION, PropertyType_String, attrs);
      }

      targetWindow.regenerateAstrometricSolution();
      console.writeln("Astrometric solution applied.");
      this.progressLabel.text = format("Solved! %d/%d tiles", result.tiles_solved, result.tiles_total);
   } else {
      console.warningln("No WCS keywords in result.");
      this.progressLabel.text = "Solved (no WCS keywords to apply)";
   }

   // Cleanup
   try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
   try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
};

//============================================================================
// Main entry point
//============================================================================

function main() {
   console.show();
   console.writeln("<b>" + TITLE + " v" + VERSION + VERSION_SUFFIX + "</b>");
   console.writeln("---");

   var dialog = new SplitSolverDialog();
   dialog.execute();
}

main();
