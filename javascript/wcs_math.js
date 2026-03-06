//============================================================================
// wcs_math.js - WCS Math Library
//
// Provides TAN (gnomonic) projection, CD matrix fitting, and centroid computation.
// Pure JavaScript compatible with both PJSR and Node.js.
//
// Copyright (c) 2024-2025 Split Image Solver Project
//============================================================================

// Math is available by default in both PJSR and Node.js environments.

//----------------------------------------------------------------------------
// TAN (gnomonic) projection: celestial coordinates -> standard coordinates
//   crval: [ra0, dec0] in degrees
//   coord: [ra, dec] in degrees
//   Returns: [xi, eta] in degrees
//----------------------------------------------------------------------------
function tanProject(crval, coord) {
   var ra0  = crval[0] * Math.PI / 180.0;
   var dec0 = crval[1] * Math.PI / 180.0;
   var ra   = coord[0] * Math.PI / 180.0;
   var dec  = coord[1] * Math.PI / 180.0;

   var cosDec  = Math.cos(dec);
   var sinDec  = Math.sin(dec);
   var cosDec0 = Math.cos(dec0);
   var sinDec0 = Math.sin(dec0);
   var dRA     = ra - ra0;
   var cosDRA  = Math.cos(dRA);

   var D = sinDec0 * sinDec + cosDec0 * cosDec * cosDRA;
   if (D <= 0) {
      return null; // Cannot project (opposite hemisphere)
   }

   var xi  = (cosDec * Math.sin(dRA)) / D * (180.0 / Math.PI);
   var eta = (cosDec0 * sinDec - sinDec0 * cosDec * cosDRA) / D * (180.0 / Math.PI);

   return [xi, eta];
}

//----------------------------------------------------------------------------
// TAN inverse projection: standard coordinates -> celestial coordinates
//   crval: [ra0, dec0] in degrees
//   standard: [xi, eta] in degrees
//   Returns: [ra, dec] in degrees
//----------------------------------------------------------------------------
function tanDeproject(crval, standard) {
   var ra0  = crval[0] * Math.PI / 180.0;
   var dec0 = crval[1] * Math.PI / 180.0;
   var xi   = standard[0] * Math.PI / 180.0;
   var eta  = standard[1] * Math.PI / 180.0;

   var rho = Math.sqrt(xi * xi + eta * eta);

   if (rho === 0) {
      return [crval[0], crval[1]];
   }

   var c = Math.atan(rho);
   var cosC = Math.cos(c);
   var sinC = Math.sin(c);
   var cosDec0 = Math.cos(dec0);
   var sinDec0 = Math.sin(dec0);

   var dec = Math.asin(cosC * sinDec0 + eta * sinC * cosDec0 / rho);
   var ra  = ra0 + Math.atan2(xi * sinC, rho * cosDec0 * cosC - eta * sinDec0 * sinC);

   // Normalize RA to 0-360
   var raDeg = ra * 180.0 / Math.PI;
   while (raDeg < 0) raDeg += 360.0;
   while (raDeg >= 360.0) raDeg -= 360.0;

   return [raDeg, dec * 180.0 / Math.PI];
}

//----------------------------------------------------------------------------
// Angular separation (Vincenty formula)
//   coord1, coord2: [ra, dec] in degrees
//   Returns: angular separation in degrees
//----------------------------------------------------------------------------
function angularSeparation(coord1, coord2) {
   var ra1  = coord1[0] * Math.PI / 180.0;
   var dec1 = coord1[1] * Math.PI / 180.0;
   var ra2  = coord2[0] * Math.PI / 180.0;
   var dec2 = coord2[1] * Math.PI / 180.0;

   var dRA = ra2 - ra1;
   var cosDec1 = Math.cos(dec1);
   var sinDec1 = Math.sin(dec1);
   var cosDec2 = Math.cos(dec2);
   var sinDec2 = Math.sin(dec2);

   var num1 = cosDec2 * Math.sin(dRA);
   var num2 = cosDec1 * sinDec2 - sinDec1 * cosDec2 * Math.cos(dRA);
   var den  = sinDec1 * sinDec2 + cosDec1 * cosDec2 * Math.cos(dRA);

   return Math.atan2(Math.sqrt(num1 * num1 + num2 * num2), den) * 180.0 / Math.PI;
}

//----------------------------------------------------------------------------
// Convex hull utilities (for inverse SIP grid filtering)
//----------------------------------------------------------------------------

// Compute CCW convex hull of 2D points using Jarvis march
//   points: array of [x, y]
//   Returns: array of [x, y] in counter-clockwise order
function convexHull(points) {
   var n = points.length;
   if (n < 3) return points.slice();

   // Find leftmost point (lowest y if tied)
   var start = 0;
   for (var i = 1; i < n; i++) {
      if (points[i][0] < points[start][0] ||
          (points[i][0] === points[start][0] && points[i][1] < points[start][1])) {
         start = i;
      }
   }

   var hull = [];
   var current = start;
   var maxIter = n + 1; // safety limit
   do {
      hull.push(points[current]);
      var next = (current === 0) ? 1 : 0;
      for (var i = 0; i < n; i++) {
         if (i === current) continue;
         // Cross product: (next - current) × (i - current)
         var cross = (points[next][0] - points[current][0]) * (points[i][1] - points[current][1]) -
                     (points[next][1] - points[current][1]) * (points[i][0] - points[current][0]);
         if (cross < 0) {
            next = i; // i is more clockwise → forms tighter CCW hull
         } else if (cross === 0) {
            // Collinear: pick the farther point
            var distI = (points[i][0] - points[current][0]) * (points[i][0] - points[current][0]) +
                        (points[i][1] - points[current][1]) * (points[i][1] - points[current][1]);
            var distN = (points[next][0] - points[current][0]) * (points[next][0] - points[current][0]) +
                        (points[next][1] - points[current][1]) * (points[next][1] - points[current][1]);
            if (distI > distN) next = i;
         }
      }
      current = next;
      maxIter--;
   } while (current !== start && maxIter > 0);

   return hull;
}

// Check if a point (px, py) is inside a CCW convex polygon
//   hull: array of [x, y] in CCW order
//   Returns: true if point is inside or on the boundary
function pointInConvexHull(hull, px, py) {
   var n = hull.length;
   if (n < 3) return false;
   for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var cross = (hull[j][0] - hull[i][0]) * (py - hull[i][1]) -
                  (hull[j][1] - hull[i][1]) * (px - hull[i][0]);
      if (cross < 0) return false;
   }
   return true;
}

// Expand a convex hull outward from its centroid by a given factor
//   hull: array of [x, y], factor: expansion ratio (e.g. 1.1 = 10% expansion)
//   Returns: expanded hull
function expandConvexHull(hull, factor) {
   var cx = 0, cy = 0;
   for (var i = 0; i < hull.length; i++) {
      cx += hull[i][0];
      cy += hull[i][1];
   }
   cx /= hull.length;
   cy /= hull.length;
   var expanded = [];
   for (var i = 0; i < hull.length; i++) {
      expanded.push([
         cx + (hull[i][0] - cx) * factor,
         cy + (hull[i][1] - cy) * factor
      ]);
   }
   return expanded;
}

//----------------------------------------------------------------------------
// SIP (Simple Imaging Polynomial) distortion correction utilities
//----------------------------------------------------------------------------

// Solve a linear system Ax = b using Gaussian elimination with partial pivoting
// A: n×n 2D array, b: length-n array
// Returns: solution vector, or null if singular
function solveLinearSystem(A, b) {
   var n = b.length;
   // Create augmented matrix [A|b]
   var aug = [];
   for (var i = 0; i < n; i++) {
      aug[i] = [];
      for (var j = 0; j < n; j++) {
         aug[i][j] = A[i][j];
      }
      aug[i][n] = b[i];
   }

   // Forward elimination with partial pivoting
   for (var col = 0; col < n; col++) {
      var maxVal = Math.abs(aug[col][col]);
      var maxRow = col;
      for (var row = col + 1; row < n; row++) {
         if (Math.abs(aug[row][col]) > maxVal) {
            maxVal = Math.abs(aug[row][col]);
            maxRow = row;
         }
      }
      if (maxVal < 1e-15) return null;

      if (maxRow !== col) {
         var tmp = aug[col];
         aug[col] = aug[maxRow];
         aug[maxRow] = tmp;
      }

      for (var row = col + 1; row < n; row++) {
         var factor = aug[row][col] / aug[col][col];
         for (var j = col; j <= n; j++) {
            aug[row][j] -= factor * aug[col][j];
         }
      }
   }

   // Back substitution
   var x = [];
   for (var i = n - 1; i >= 0; i--) {
      if (Math.abs(aug[i][i]) < 1e-15) return null;
      var sum = aug[i][n];
      for (var j = i + 1; j < n; j++) {
         sum -= aug[i][j] * x[j];
      }
      x[i] = sum / aug[i][i];
   }

   return x;
}

// Solve underdetermined system D*x = b (m < n) via minimum-norm solution
// x = D^T * (D * D^T)^{-1} * b
// D: m×n (m < n), b: length-m → returns length-n solution, or null if singular
function solveMinNorm(D, b) {
   var m = D.length;
   var n = D[0].length;

   // Try without regularization, then with Tikhonov regularization as fallback
   var y = null;
   for (var attempt = 0; attempt < 2; attempt++) {
      var G = [];
      for (var i = 0; i < m; i++) {
         G[i] = [];
         for (var j = 0; j < m; j++) {
            var s = 0;
            for (var k = 0; k < n; k++) s += D[i][k] * D[j][k];
            G[i][j] = s;
         }
      }
      if (attempt === 1) {
         var maxDiag = 0;
         for (var i = 0; i < m; i++) {
            if (G[i][i] > maxDiag) maxDiag = G[i][i];
         }
         var eps = maxDiag * 1e-10;
         for (var i = 0; i < m; i++) G[i][i] += eps;
      }
      y = solveLinearSystem(G, b);
      if (y !== null) break;
   }
   if (y === null) return null;

   // x = D^T * y
   var x = [];
   for (var j = 0; j < n; j++) {
      var s = 0;
      for (var i = 0; i < m; i++) s += D[i][j] * y[i];
      x[j] = s;
   }
   return x;
}

// Fit 2D polynomial to residuals: target = sum of coeff * u^p * v^q (2 <= p+q <= order)
// Returns array of [p, q, coeff] (same format as SIP), or null if insufficient data
function fitPolynomial2D(uArr, vArr, targetArr, order) {
   if (!order || order < 2) order = 2;
   // Build basis: u^p * v^q for 2 <= p+q <= order
   var basis = [];
   for (var deg = 2; deg <= order; deg++) {
      for (var p = deg; p >= 0; p--) {
         var q = deg - p;
         basis.push([p, q]);
      }
   }
   var nTerms = basis.length;
   var nData = uArr.length;
   if (nData < nTerms) return null;

   // Build design matrix M (nData x nTerms)
   var M = [];
   for (var i = 0; i < nData; i++) {
      M[i] = [];
      for (var j = 0; j < nTerms; j++) {
         M[i][j] = Math.pow(uArr[i], basis[j][0]) * Math.pow(vArr[i], basis[j][1]);
      }
   }

   // Normal equations: (M^T M) x = M^T b
   var MtM = [];
   var Mtb = [];
   for (var j = 0; j < nTerms; j++) {
      MtM[j] = [];
      var s = 0;
      for (var i = 0; i < nData; i++) s += M[i][j] * targetArr[i];
      Mtb[j] = s;
      for (var k = 0; k < nTerms; k++) {
         var ss = 0;
         for (var i = 0; i < nData; i++) ss += M[i][j] * M[i][k];
         MtM[j][k] = ss;
      }
   }

   var coeffs = solveLinearSystem(MtM, Mtb);
   if (!coeffs) return null;

   var result = [];
   for (var j = 0; j < nTerms; j++) {
      result.push([basis[j][0], basis[j][1], coeffs[j]]);
   }
   return result;
}

// Evaluate SIP polynomial: sum of coeff * u^p * v^q
// sipCoeffs: array of [p, q, value]
function evalSipPolynomial(sipCoeffs, u, v) {
   var result = 0;
   for (var i = 0; i < sipCoeffs.length; i++) {
      var p = sipCoeffs[i][0];
      var q = sipCoeffs[i][1];
      var c = sipCoeffs[i][2];
      result += c * Math.pow(u, p) * Math.pow(v, q);
   }
   return result;
}

// Determine SIP order based on number of stars
// mode: "approx" (default, least-squares) or "interp" (min-norm interpolation)
// Returns 0 (no SIP), 2, 3, 4, 5, 6, or 7, 8, or 9
function determineSipOrder(nStars, mode) {
   if (!mode) mode = "approx";
   if (mode === "interp") {
      // 補間モード: P-norm 境界エネルギー抑制のため十分な自由度を確保
      // 最低条件: 項数 >= 星数（厳密補間に必要）
      // 推奨: 自由度(= 項数 - 星数) >= 25（広角画像での SIP 暴走抑制）
      // 次数K → 項数 = (K+1)(K+2)/2 - 3
      // 次数3→7, 4→12, 5→18, 6→25, 7→33, 8→42, 9→52
      if (nStars <= 3) return 0;
      if (nStars > 42) return 9;
      // 最低次数（項数 >= 星数）
      var minOrder = 3;
      if (nStars > 7) minOrder = 4;
      if (nStars > 12) minOrder = 5;
      if (nStars > 18) minOrder = 6;
      if (nStars > 25) minOrder = 7;
      if (nStars > 33) minOrder = 8;
      // 自由度 >= 25 となる次数まで引き上げ（最大 order 9）
      var targetOrder = minOrder;
      while (targetOrder < 9) {
         var nTerms = (targetOrder + 1) * (targetOrder + 2) / 2 - 3;
         if (nTerms >= nStars + 25) break;
         targetOrder++;
      }
      return targetOrder;
   }
   // 近似モード（既存ロジック）
   if (nStars >= 10) return 3;
   if (nStars >= 6) return 2;
   return 0;
}

//----------------------------------------------------------------------------
// WCSFitter: Fit a TAN projection WCS from star pairs
//
//   starPairs: array of [{px, py, ra, dec, name}] (requires 4 or more)
//   imageWidth, imageHeight: image dimensions in pixels
//----------------------------------------------------------------------------
function WCSFitter(starPairs, imageWidth, imageHeight) {
   this.stars = starPairs;
   this.width = imageWidth;
   this.height = imageHeight;
   // CRPIX is the image center (FITS 1-based)
   this.crpix1 = imageWidth / 2.0 + 0.5;
   this.crpix2 = imageHeight / 2.0 + 0.5;
}

//----------------------------------------------------------------------------
// SIP distortion fitting (called from solve after TAN fit)
//   crval: [ra0, dec0], cd: 2x2 array, uObs/vObs: pixel offset arrays
//   Returns: {order, a, b} or null
//----------------------------------------------------------------------------
WCSFitter.prototype._fitSip = function (crval, cd, uObs, vObs, mode, crpix) {
   var stars = this.stars;
   var nStars = stars.length;
   var order = determineSipOrder(nStars, mode);
   if (order === 0) return null;

   // Invert CD matrix
   var det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
   if (Math.abs(det) < 1e-30) return null;
   var cdInv = [
      [cd[1][1] / det, -cd[0][1] / det],
      [-cd[1][0] / det, cd[0][0] / det]
   ];

   // Compute ideal pixel offsets and SIP targets
   var du = [], dv = [];
   for (var i = 0; i < nStars; i++) {
      var proj = tanProject(crval, [stars[i].ra, stars[i].dec]);
      if (proj === null) return null;
      var uIdeal = cdInv[0][0] * proj[0] + cdInv[0][1] * proj[1];
      var vIdeal = cdInv[1][0] * proj[0] + cdInv[1][1] * proj[1];
      du.push(uIdeal - uObs[i]);
      dv.push(vIdeal - vObs[i]);
   }

   // Interp mode: generate weighted anchor points for P-norm energy suppression
   // 境界アンカー（高重み）: FOV を正確に保つ
   // グリッドアンカー（低重み）: 内部の多項式振動を抑制
   var anchorU = [], anchorV = [], anchorW = [];
   if (mode === "interp" && crpix) {
      var crpix1 = crpix[0], crpix2 = crpix[1];
      var uMin = 1 - crpix1, uMax = this.width - crpix1;
      var vMin = 1 - crpix2, vMax = this.height - crpix2;
      var W_BOUNDARY = 10;
      var W_GRID = 1;
      // 境界アンカー: 各辺10点（36点）
      var nPerEdge = 10;
      for (var ei = 0; ei < nPerEdge; ei++) {
         var tU = uMin + ei * (uMax - uMin) / (nPerEdge - 1);
         var tV = vMin + ei * (vMax - vMin) / (nPerEdge - 1);
         anchorU.push(tU); anchorV.push(vMin); anchorW.push(W_BOUNDARY);
         anchorU.push(tU); anchorV.push(vMax); anchorW.push(W_BOUNDARY);
         if (ei > 0 && ei < nPerEdge - 1) {
            anchorU.push(uMin); anchorV.push(tV); anchorW.push(W_BOUNDARY);
            anchorU.push(uMax); anchorV.push(tV); anchorW.push(W_BOUNDARY);
         }
      }
      // グリッドアンカー: 7×7 内部点（49点）
      var nGrid = 7;
      for (var gi = 0; gi < nGrid; gi++) {
         for (var gj = 0; gj < nGrid; gj++) {
            anchorU.push(uMin + gi * (uMax - uMin) / (nGrid - 1));
            anchorV.push(vMin + gj * (vMax - vMin) / (nGrid - 1));
            anchorW.push(W_GRID);
         }
      }
   }

   // Coordinate normalization for numerical stability
   var coordScale = 0;
   for (var i = 0; i < nStars; i++) {
      coordScale = Math.max(coordScale, Math.abs(uObs[i]), Math.abs(vObs[i]));
   }
   for (var a = 0; a < anchorU.length; a++) {
      coordScale = Math.max(coordScale, Math.abs(anchorU[a]), Math.abs(anchorV[a]));
   }
   if (coordScale < 1) coordScale = 1;

   // Build basis: (p, q) for 2 <= p+q <= order
   var basis = [];
   for (var total = 2; total <= order; total++) {
      for (var p = total; p >= 0; p--) {
         basis.push([p, total - p]);
      }
   }
   var nBasis = basis.length;

   // Pre-compute basis function values for stars (normalized coordinates)
   var starBasis = [];
   for (var i = 0; i < nStars; i++) {
      var uN = uObs[i] / coordScale;
      var vN = vObs[i] / coordScale;
      starBasis[i] = [];
      for (var j = 0; j < nBasis; j++) {
         starBasis[i][j] = Math.pow(uN, basis[j][0]) * Math.pow(vN, basis[j][1]);
      }
   }

   var aNorm, bNorm;

   if (mode === "interp" && nBasis > nStars && anchorU.length > 0) {
      // P-ノルム最小化: 星を厳密に補間しつつ境界 SIP 値を最小化
      // x = P^{-1} D^T (D P^{-1} D^T)^{-1} b
      // P = M_anchor^T M_anchor + εI（境界エネルギー行列）
      var nAnchors = anchorU.length;

      // Pre-compute basis for anchor points
      var ancBasis = [];
      for (var a = 0; a < nAnchors; a++) {
         var uN = anchorU[a] / coordScale;
         var vN = anchorV[a] / coordScale;
         ancBasis[a] = [];
         for (var j = 0; j < nBasis; j++) {
            ancBasis[a][j] = Math.pow(uN, basis[j][0]) * Math.pow(vN, basis[j][1]);
         }
      }

      // P = M_anchor^T W M_anchor (nBasis × nBasis), W = diag(anchorW)
      var P = [];
      for (var j = 0; j < nBasis; j++) {
         P[j] = [];
         for (var k = 0; k < nBasis; k++) {
            var s = 0;
            for (var a = 0; a < nAnchors; a++) {
               s += anchorW[a] * ancBasis[a][j] * ancBasis[a][k];
            }
            P[j][k] = s;
         }
      }

      // Regularization: P += εI for numerical stability
      var maxDiag = 0;
      for (var j = 0; j < nBasis; j++) {
         if (P[j][j] > maxDiag) maxDiag = P[j][j];
      }
      var eps = maxDiag * 1e-10;
      for (var j = 0; j < nBasis; j++) P[j][j] += eps;

      // For each star i, solve P q_i = starBasis[i]
      var Q = [];
      var pOk = true;
      for (var i = 0; i < nStars; i++) {
         var qi = solveLinearSystem(P, starBasis[i]);
         if (qi === null) { pOk = false; break; }
         Q[i] = qi;
      }

      if (pOk) {
         // G[i][j] = starBasis[i] · Q[j]
         var G = [];
         for (var i = 0; i < nStars; i++) {
            G[i] = [];
            for (var j = 0; j < nStars; j++) {
               var s = 0;
               for (var k = 0; k < nBasis; k++) {
                  s += starBasis[i][k] * Q[j][k];
               }
               G[i][j] = s;
            }
         }

         var yu = solveLinearSystem(G, du);
         var yv = solveLinearSystem(G, dv);

         if (yu !== null && yv !== null) {
            aNorm = [];
            bNorm = [];
            for (var k = 0; k < nBasis; k++) {
               var sa = 0, sb = 0;
               for (var i = 0; i < nStars; i++) {
                  sa += Q[i][k] * yu[i];
                  sb += Q[i][k] * yv[i];
               }
               aNorm[k] = sa;
               bNorm[k] = sb;
            }
         }
      }

      // Fallback to standard min-norm if P-norm failed
      if (!aNorm || !bNorm) {
         var D = [];
         for (var i = 0; i < nStars; i++) {
            D[i] = [];
            for (var j = 0; j < nBasis; j++) D[i][j] = starBasis[i][j];
         }
         aNorm = solveMinNorm(D, du);
         bNorm = solveMinNorm(D, dv);
      }
   } else if (mode === "interp" && nBasis > nStars) {
      // No anchors: standard min-norm
      var D = [];
      for (var i = 0; i < nStars; i++) {
         D[i] = [];
         for (var j = 0; j < nBasis; j++) D[i][j] = starBasis[i][j];
      }
      aNorm = solveMinNorm(D, du);
      bNorm = solveMinNorm(D, dv);
   } else {
      // 近似モード or 正方/優決定系: 正規方程式 (M^T M) x = M^T b
      var MtM = [];
      var MtDu = [];
      var MtDv = [];
      for (var j = 0; j < nBasis; j++) {
         MtM[j] = [];
         MtDu[j] = 0;
         MtDv[j] = 0;
         for (var k = 0; k < nBasis; k++) MtM[j][k] = 0;
      }
      for (var i = 0; i < nStars; i++) {
         for (var j = 0; j < nBasis; j++) {
            MtDu[j] += starBasis[i][j] * du[i];
            MtDv[j] += starBasis[i][j] * dv[i];
            for (var k = j; k < nBasis; k++) {
               MtM[j][k] += starBasis[i][j] * starBasis[i][k];
            }
         }
      }
      for (var j = 0; j < nBasis; j++) {
         for (var k = 0; k < j; k++) {
            MtM[j][k] = MtM[k][j];
         }
      }
      aNorm = solveLinearSystem(MtM, MtDu);
      bNorm = solveLinearSystem(MtM, MtDv);
   }

   if (aNorm === null) return null;
   if (bNorm === null) return null;

   // Descale: a[p,q] = aNorm[p,q] / coordScale^(p+q)
   var sipA = [], sipB = [];
   for (var j = 0; j < nBasis; j++) {
      var p = basis[j][0], q = basis[j][1];
      var sf = Math.pow(coordScale, p + q);
      sipA.push([p, q, aNorm[j] / sf]);
      sipB.push([p, q, bNorm[j] / sf]);
   }

   return { order: order, a: sipA, b: sipB };
};

//----------------------------------------------------------------------------
// Compute inverse SIP (AP, BP) from forward SIP (A, B) using grid fitting
//   sipA, sipB: forward SIP coefficients, order: SIP order
//   uRange, vRange: [min, max] pixel offset ranges (null if starPositions used)
//   starPositions: optional array of [u, v] star positions for star-local mode
//     When provided, training data is generated from perturbations around each
//     star instead of a uniform grid (avoids Runge oscillation between stars)
//   invOrder: optional override for inverse SIP order (default = order)
//   Returns: {ap, bp} or null
//----------------------------------------------------------------------------
WCSFitter.prototype._computeInverseSip = function (sipA, sipB, order, uRange, vRange, starPositions, invOrder) {
   if (!invOrder) invOrder = order;

   // Build basis function indices
   var basis = [];
   for (var total = 2; total <= invOrder; total++) {
      for (var p = total; p >= 0; p--) {
         basis.push([p, total - p]);
      }
   }
   var nBasis = basis.length;

   // Generate training data for inverse SIP
   var points = [];

   if (starPositions && starPositions.length > 0) {
      // Star-local mode: generate perturbation points around each star
      // Forward SIP is only reliable near star positions (Runge phenomenon)
      var nStars = starPositions.length;

      // Compute perturbation radius: 1/10 of median nearest-neighbor distance
      var nnDists = [];
      for (var i = 0; i < nStars; i++) {
         var minDist = Infinity;
         for (var j = 0; j < nStars; j++) {
            if (i === j) continue;
            var dx = starPositions[i][0] - starPositions[j][0];
            var dy = starPositions[i][1] - starPositions[j][1];
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < minDist) minDist = d;
         }
         nnDists.push(minDist);
      }
      nnDists.sort(function (a, b) { return a - b; });
      var medianNN = nnDists[Math.floor(nStars / 2)];
      var delta = Math.max(10, Math.min(100, medianNN / 10));

      // 5×5 perturbation grid around each star
      var offsets = [-2 * delta, -delta, 0, delta, 2 * delta];
      for (var si = 0; si < nStars; si++) {
         var su = starPositions[si][0];
         var sv = starPositions[si][1];
         for (var oi = 0; oi < offsets.length; oi++) {
            for (var oj = 0; oj < offsets.length; oj++) {
               var u = su + offsets[oi];
               var v = sv + offsets[oj];
               var fA = evalSipPolynomial(sipA, u, v);
               var fB = evalSipPolynomial(sipB, u, v);
               points.push({
                  up: u + fA,
                  vp: v + fB,
                  targetAP: -fA,
                  targetBP: -fB
               });
            }
         }
      }
   } else {
      // Standard grid mode (for approx mode)
      var nGrid = 50;
      var uStep = (uRange[1] - uRange[0]) / (nGrid - 1);
      var vStep = (vRange[1] - vRange[0]) / (nGrid - 1);
      for (var gi = 0; gi < nGrid; gi++) {
         for (var gj = 0; gj < nGrid; gj++) {
            var u = uRange[0] + gi * uStep;
            var v = vRange[0] + gj * vStep;
            var fA = evalSipPolynomial(sipA, u, v);
            var fB = evalSipPolynomial(sipB, u, v);
            points.push({
               up: u + fA,
               vp: v + fB,
               targetAP: -fA,
               targetBP: -fB
            });
         }
      }
   }
   var nPoints = points.length;
   if (nPoints < nBasis * 2) return null; // not enough valid points

   // Normalize coordinates
   var coordScale = 0;
   for (var i = 0; i < nPoints; i++) {
      coordScale = Math.max(coordScale, Math.abs(points[i].up), Math.abs(points[i].vp));
   }
   if (coordScale < 1) coordScale = 1;

   // Build normal equations with pre-cached basis values
   var MtM = [];
   var MtAP = [];
   var MtBP = [];
   for (var j = 0; j < nBasis; j++) {
      MtM[j] = [];
      MtAP[j] = 0;
      MtBP[j] = 0;
      for (var k = 0; k < nBasis; k++) MtM[j][k] = 0;
   }

   for (var i = 0; i < nPoints; i++) {
      var uN = points[i].up / coordScale;
      var vN = points[i].vp / coordScale;
      var bv = [];
      for (var j = 0; j < nBasis; j++) {
         bv[j] = Math.pow(uN, basis[j][0]) * Math.pow(vN, basis[j][1]);
      }
      for (var j = 0; j < nBasis; j++) {
         MtAP[j] += bv[j] * points[i].targetAP;
         MtBP[j] += bv[j] * points[i].targetBP;
         for (var k = j; k < nBasis; k++) {
            MtM[j][k] += bv[j] * bv[k];
         }
      }
   }
   for (var j = 0; j < nBasis; j++) {
      for (var k = 0; k < j; k++) {
         MtM[j][k] = MtM[k][j];
      }
   }

   var apNorm = solveLinearSystem(MtM, MtAP);
   var bpNorm = solveLinearSystem(MtM, MtBP);
   if (apNorm === null || bpNorm === null) return null;

   // Descale
   var sipAP = [], sipBP = [];
   for (var j = 0; j < nBasis; j++) {
      var p = basis[j][0], q = basis[j][1];
      var sf = Math.pow(coordScale, p + q);
      sipAP.push([p, q, apNorm[j] / sf]);
      sipBP.push([p, q, bpNorm[j] / sf]);
   }

   return { ap: sipAP, bp: sipBP };
};

//----------------------------------------------------------------------------
// 逆SIP直接計算: 星の正確な位置データから逆SIP(AP, BP)を計算
// forward SIPを使わず、星の天球座標とピクセル座標から直接計算するため
// forward SIP の多項式振動(Runge現象)の影響を受けない
// 線形項(order 1)を含む基底を使用し、CRVAL近傍での感度を改善
// P-norm方式: 星位置を正確に補間しつつ摂動アンカーで滑らかさを保証
//   crval: [ra0, dec0], cd: 2x2 CD matrix
//   uObs, vObs: pixel offset arrays (relative to CRPIX)
//   Returns: {ap, bp, invOrder} or null
//----------------------------------------------------------------------------
WCSFitter.prototype._computeInverseSipDirect = function (crval, cd, uObs, vObs) {
   var stars = this.stars;
   var nStars = stars.length;
   if (nStars < 4) return null;

   // CD inverse
   var det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
   if (Math.abs(det) < 1e-30) return null;
   var cdInv = [
      [cd[1][1] / det, -cd[0][1] / det],
      [-cd[1][0] / det, cd[0][0] / det]
   ];

   // Inverse SIP order: nBasis >= nStars + 5
   // nBasis(N, start=1) = N*(N+3)/2
   var invOrder = 4;
   while (invOrder * (invOrder + 3) / 2 < nStars + 5) {
      invOrder++;
      if (invOrder > 9) break;
   }

   // Build basis with linear terms (start from order 1)
   var basis = [];
   for (var total = 1; total <= invOrder; total++) {
      for (var p = total; p >= 0; p--) {
         basis.push([p, total - p]);
      }
   }
   var nBasis = basis.length;

   // Compute exact inverse mapping at each star
   // (RA, Dec) → TAN project → CD⁻¹ → (u', v')
   // Target: AP(u', v') = u - u', BP(u', v') = v - v'
   var starUp = [], starVp = [];
   var targetAP = [], targetBP = [];
   for (var i = 0; i < nStars; i++) {
      var proj = tanProject(crval, [stars[i].ra, stars[i].dec]);
      if (!proj) return null;
      var up = cdInv[0][0] * proj[0] + cdInv[0][1] * proj[1];
      var vp = cdInv[1][0] * proj[0] + cdInv[1][1] * proj[1];
      starUp.push(up);
      starVp.push(vp);
      targetAP.push(uObs[i] - up);
      targetBP.push(vObs[i] - vp);
   }

   // Perturbation delta based on (u', v') nearest-neighbor distance
   var nnDists = [];
   for (var i = 0; i < nStars; i++) {
      var minDist = Infinity;
      for (var j = 0; j < nStars; j++) {
         if (i === j) continue;
         var dx = starUp[i] - starUp[j];
         var dy = starVp[i] - starVp[j];
         var d = Math.sqrt(dx * dx + dy * dy);
         if (d < minDist) minDist = d;
      }
      nnDists.push(minDist);
   }
   nnDists.sort(function (a, b) { return a - b; });
   var medianNN = nnDists[Math.floor(nStars / 2)];
   var delta = Math.max(10, Math.min(100, medianNN / 10));

   // Collect data points: exact star positions (high weight) + perturbation anchors (low weight)
   var W_STAR = 1e6;
   var W_ANCHOR = 1;

   // All (u', v') coordinates and targets
   var allUp = [], allVp = [], allTargetAP = [], allTargetBP = [], allWeight = [];

   // Exact star data (high weight)
   for (var i = 0; i < nStars; i++) {
      allUp.push(starUp[i]);
      allVp.push(starVp[i]);
      allTargetAP.push(targetAP[i]);
      allTargetBP.push(targetBP[i]);
      allWeight.push(W_STAR);
   }

   // Perturbation anchors (low weight): same correction at nearby offsets
   var offsets = [-2 * delta, -delta, delta, 2 * delta];
   for (var si = 0; si < nStars; si++) {
      for (var oi = 0; oi < offsets.length; oi++) {
         for (var oj = 0; oj < offsets.length; oj++) {
            allUp.push(starUp[si] + offsets[oi]);
            allVp.push(starVp[si] + offsets[oj]);
            allTargetAP.push(targetAP[si]);
            allTargetBP.push(targetBP[si]);
            allWeight.push(W_ANCHOR);
         }
      }
   }
   var nPoints = allUp.length;

   // Coordinate normalization
   var coordScale = 0;
   for (var i = 0; i < nPoints; i++) {
      coordScale = Math.max(coordScale, Math.abs(allUp[i]), Math.abs(allVp[i]));
   }
   if (coordScale < 1) coordScale = 1;

   // Weighted normal equations: (M^T W M) x = M^T W b
   var MtM = [], MtAP = [], MtBP = [];
   for (var j = 0; j < nBasis; j++) {
      MtM[j] = [];
      MtAP[j] = 0;
      MtBP[j] = 0;
      for (var k = 0; k < nBasis; k++) MtM[j][k] = 0;
   }
   for (var i = 0; i < nPoints; i++) {
      var w = allWeight[i];
      var uN = allUp[i] / coordScale;
      var vN = allVp[i] / coordScale;
      var bv = [];
      for (var j = 0; j < nBasis; j++) {
         bv[j] = Math.pow(uN, basis[j][0]) * Math.pow(vN, basis[j][1]);
      }
      for (var j = 0; j < nBasis; j++) {
         MtAP[j] += w * bv[j] * allTargetAP[i];
         MtBP[j] += w * bv[j] * allTargetBP[i];
         for (var k = j; k < nBasis; k++) {
            MtM[j][k] += w * bv[j] * bv[k];
         }
      }
   }
   for (var j = 0; j < nBasis; j++) {
      for (var k = 0; k < j; k++) MtM[j][k] = MtM[k][j];
   }
   // Regularization
   var maxDiag = 0;
   for (var j = 0; j < nBasis; j++) {
      if (MtM[j][j] > maxDiag) maxDiag = MtM[j][j];
   }
   for (var j = 0; j < nBasis; j++) MtM[j][j] += maxDiag * 1e-10;

   var apNorm = solveLinearSystem(MtM, MtAP);
   var bpNorm = solveLinearSystem(MtM, MtBP);
   if (!apNorm || !bpNorm) return null;

   // Descale
   var sipAP = [], sipBP = [];
   for (var j = 0; j < nBasis; j++) {
      var p = basis[j][0], q = basis[j][1];
      var sf = Math.pow(coordScale, p + q);
      sipAP.push([p, q, apNorm[j] / sf]);
      sipBP.push([p, q, bpNorm[j] / sf]);
   }

   return { ap: sipAP, bp: sipBP, invOrder: invOrder };
};

WCSFitter.prototype.solve = function () {
   var stars = this.stars;
   var nStars = stars.length;

   if (nStars < 4) {
      return {
         success: false,
         message: "At least 4 star pairs required (current: " + nStars + ")"
      };
   }

   // RA/DEC range check
   for (var i = 0; i < nStars; i++) {
      if (stars[i].ra < 0 || stars[i].ra >= 360) {
         return {
            success: false,
            message: "Star " + (i + 1) + " RA is out of range: " + stars[i].ra
         };
      }
      if (stars[i].dec < -90 || stars[i].dec > 90) {
         return {
            success: false,
            message: "Star " + (i + 1) + " DEC is out of range: " + stars[i].dec
         };
      }
   }

   var crpix1 = this.crpix1;
   var crpix2 = this.crpix2;

   // --- 1. CRVAL initial value = centroid of star celestial coordinates ---
   // Use 3D unit vector mean on the celestial sphere.
   // This correctly handles circumpolar fields where stars wrap around in RA.
   var sumVX = 0, sumVY = 0, sumVZ = 0;
   for (var i = 0; i < nStars; i++) {
      var raRad = stars[i].ra * Math.PI / 180.0;
      var decRad = stars[i].dec * Math.PI / 180.0;
      sumVX += Math.cos(decRad) * Math.cos(raRad);
      sumVY += Math.cos(decRad) * Math.sin(raRad);
      sumVZ += Math.sin(decRad);
   }
   var crval1 = Math.atan2(sumVY, sumVX) * 180.0 / Math.PI;
   if (crval1 < 0) crval1 += 360.0;
   var rXY = Math.sqrt(sumVX * sumVX + sumVY * sumVY);
   var crval2 = Math.atan2(sumVZ, rXY) * 180.0 / Math.PI;

   // --- 2-4. Iterate: TAN projection -> CD matrix fit -> CRVAL update ---
   var cd = [[0, 0], [0, 0]];
   var maxIter = 5;

   for (var iter = 0; iter < maxIter; iter++) {
      var crval = [crval1, crval2];

      // Compute standard coordinates via TAN projection
      var projOk = true;
      var xiArr = [];
      var etaArr = [];
      for (var i = 0; i < nStars; i++) {
         var proj = tanProject(crval, [stars[i].ra, stars[i].dec]);
         if (proj === null) {
            projOk = false;
            break;
         }
         xiArr.push(proj[0]);
         etaArr.push(proj[1]);
      }

      if (!projOk) {
         return {
            success: false,
            message: "TAN projection failed (stars may be in the opposite hemisphere)"
         };
      }

      // Pixel offset u, v (relative to CRPIX)
      // Standard FITS coordinate system: y=1 is at the image bottom. fits_y = height - py.
      var uArr = [];
      var vArr = [];
      for (var i = 0; i < nStars; i++) {
         uArr.push((stars[i].px + 1.0) - crpix1);
         vArr.push((this.height - stars[i].py) - crpix2);
      }

      // Compute terms of the normal equations
      var sumUU = 0, sumUV = 0, sumVV = 0;
      var sumUXi = 0, sumVXi = 0;
      var sumUEta = 0, sumVEta = 0;
      for (var i = 0; i < nStars; i++) {
         sumUU += uArr[i] * uArr[i];
         sumUV += uArr[i] * vArr[i];
         sumVV += vArr[i] * vArr[i];
         sumUXi  += uArr[i] * xiArr[i];
         sumVXi  += vArr[i] * xiArr[i];
         sumUEta += uArr[i] * etaArr[i];
         sumVEta += vArr[i] * etaArr[i];
      }

      // Solve CD matrix using Cramer's rule
      var det = sumUU * sumVV - sumUV * sumUV;
      if (Math.abs(det) < 1e-30) {
         return {
            success: false,
            message: "Normal equation determinant is zero (stars may be collinear)"
         };
      }

      cd[0][0] = (sumUXi * sumVV - sumVXi * sumUV) / det;   // CD1_1
      cd[0][1] = (sumUU * sumVXi - sumUV * sumUXi) / det;   // CD1_2
      cd[1][0] = (sumUEta * sumVV - sumVEta * sumUV) / det;  // CD2_1
      cd[1][1] = (sumUU * sumVEta - sumUV * sumUEta) / det;  // CD2_2

      // Update CRVAL: inverse transform CRPIX (image center) -> celestial coords
      // Since the offset at CRPIX is (0, 0), standard coords are also (0, 0)
      // -> CRVAL doesn't change. But if CRPIX is offset from the pixel center, update it.
      // Here we use a fixed CRPIX with fine-tuned CRVAL:
      // Correct CRVAL using the centroid of all star residuals
      var sumDXi = 0, sumDEta = 0;
      for (var i = 0; i < nStars; i++) {
         var predXi  = cd[0][0] * uArr[i] + cd[0][1] * vArr[i];
         var predEta = cd[1][0] * uArr[i] + cd[1][1] * vArr[i];
         sumDXi  += xiArr[i] - predXi;
         sumDEta += etaArr[i] - predEta;
      }
      var meanDXi  = sumDXi / nStars;
      var meanDEta = sumDEta / nStars;

      // Inverse transform residual centroid to celestial coords and update CRVAL
      var newCrval = tanDeproject([crval1, crval2], [meanDXi, meanDEta]);

      // Verify that updated CRVAL doesn't break TAN projection for any star.
      // For wide-field images, the non-linear TAN projection can cause the
      // CRVAL update to overshoot, pushing edge stars beyond the 90-degree limit.
      var updateOk = true;
      for (var j = 0; j < nStars; j++) {
         if (tanProject(newCrval, [stars[j].ra, stars[j].dec]) === null) {
            updateOk = false;
            break;
         }
      }
      if (updateOk) {
         crval1 = newCrval[0];
         crval2 = newCrval[1];
      }
   }

   // --- 5. Compute TAN-only residuals ---
   var crval = [crval1, crval2];
   var residuals = [];
   var totalResidSq = 0;
   var uObs = [];
   var vObs = [];

   for (var i = 0; i < nStars; i++) {
      var u = (stars[i].px + 1.0) - crpix1;
      var v = (this.height - stars[i].py) - crpix2;
      uObs.push(u);
      vObs.push(v);

      var predXi  = cd[0][0] * u + cd[0][1] * v;
      var predEta = cd[1][0] * u + cd[1][1] * v;
      var predCoord = tanDeproject(crval, [predXi, predEta]);
      var resid = angularSeparation([stars[i].ra, stars[i].dec], predCoord);
      var residArcsec = resid * 3600.0;
      residuals.push({
         name: stars[i].name || ("Star " + (i + 1)),
         residual_arcsec: residArcsec
      });
      totalResidSq += residArcsec * residArcsec;
   }

   var rmsArcsec = Math.sqrt(totalResidSq / nStars);
   var tanRmsArcsec = rmsArcsec;

   // Pixel scale computation (from CD matrix singular values)
   var pixelScaleArcsec = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) * 3600.0;

   // --- 6. SIP distortion fitting with iterative CD refinement ---
   var sipResult = null;
   var sipMode = undefined;

   // Determine SIP mode: interp if TAN residual >= 5 pixels, else approx
   var tanRmsPixel = tanRmsArcsec / pixelScaleArcsec;
   var autoSipMode = (tanRmsPixel >= 5.0) ? "interp" : "approx";

   if (determineSipOrder(nStars, autoSipMode) > 0) {
      sipMode = autoSipMode;

      // Save original TAN solution in case SIP doesn't help
      var tanCd = [[cd[0][0], cd[0][1]], [cd[1][0], cd[1][1]]];
      var tanCrval1 = crval1, tanCrval2 = crval2;
      var sipFit = null;

      // Iterate: fit SIP → refit CD+CRVAL with SIP-corrected coords → repeat
      for (var sipIter = 0; sipIter < 10; sipIter++) {
         sipFit = this._fitSip([crval1, crval2], cd, uObs, vObs, sipMode, [crpix1, crpix2]);
         if (!sipFit) break;

         // Refit CD using SIP-corrected pixel offsets
         var projOk2 = true;
         var xiArr2 = [], etaArr2 = [];
         var uCorrArr = [], vCorrArr = [];
         for (var i = 0; i < nStars; i++) {
            uCorrArr[i] = uObs[i] + evalSipPolynomial(sipFit.a, uObs[i], vObs[i]);
            vCorrArr[i] = vObs[i] + evalSipPolynomial(sipFit.b, uObs[i], vObs[i]);
            var proj2 = tanProject([crval1, crval2], [stars[i].ra, stars[i].dec]);
            if (proj2 === null) { projOk2 = false; break; }
            xiArr2[i] = proj2[0];
            etaArr2[i] = proj2[1];
         }
         if (!projOk2) { sipFit = null; break; }

         var sumUU2 = 0, sumUV2 = 0, sumVV2 = 0;
         var sumUXi2 = 0, sumVXi2 = 0, sumUEta2 = 0, sumVEta2 = 0;
         for (var i = 0; i < nStars; i++) {
            sumUU2  += uCorrArr[i] * uCorrArr[i];
            sumUV2  += uCorrArr[i] * vCorrArr[i];
            sumVV2  += vCorrArr[i] * vCorrArr[i];
            sumUXi2  += uCorrArr[i] * xiArr2[i];
            sumVXi2  += vCorrArr[i] * xiArr2[i];
            sumUEta2 += uCorrArr[i] * etaArr2[i];
            sumVEta2 += vCorrArr[i] * etaArr2[i];
         }
         var det2 = sumUU2 * sumVV2 - sumUV2 * sumUV2;
         if (Math.abs(det2) < 1e-30) { sipFit = null; break; }

         cd[0][0] = (sumUXi2 * sumVV2 - sumVXi2 * sumUV2) / det2;
         cd[0][1] = (sumUU2 * sumVXi2 - sumUV2 * sumUXi2) / det2;
         cd[1][0] = (sumUEta2 * sumVV2 - sumVEta2 * sumUV2) / det2;
         cd[1][1] = (sumUU2 * sumVEta2 - sumUV2 * sumUEta2) / det2;

         // Update CRVAL
         var sumDXi2 = 0, sumDEta2 = 0;
         for (var i = 0; i < nStars; i++) {
            var predXi3 = cd[0][0] * uCorrArr[i] + cd[0][1] * vCorrArr[i];
            var predEta3 = cd[1][0] * uCorrArr[i] + cd[1][1] * vCorrArr[i];
            sumDXi2  += xiArr2[i] - predXi3;
            sumDEta2 += etaArr2[i] - predEta3;
         }
         var newCrval2 = tanDeproject([crval1, crval2], [sumDXi2 / nStars, sumDEta2 / nStars]);
         crval1 = newCrval2[0];
         crval2 = newCrval2[1];
      }

      // Final SIP fit with refined CD
      if (sipFit) {
         sipFit = this._fitSip([crval1, crval2], cd, uObs, vObs, sipMode, [crpix1, crpix2]);
      }

      if (sipFit) {
         // Compute SIP-corrected residuals
         var sipTotalResidSq = 0;
         var sipResiduals = [];
         for (var i = 0; i < nStars; i++) {
            var up = uObs[i] + evalSipPolynomial(sipFit.a, uObs[i], vObs[i]);
            var vp = vObs[i] + evalSipPolynomial(sipFit.b, uObs[i], vObs[i]);
            var predXi2  = cd[0][0] * up + cd[0][1] * vp;
            var predEta2 = cd[1][0] * up + cd[1][1] * vp;
            var predCoord2 = tanDeproject([crval1, crval2], [predXi2, predEta2]);
            var resid2 = angularSeparation([stars[i].ra, stars[i].dec], predCoord2);
            var residArcsec2 = resid2 * 3600.0;
            sipResiduals.push({
               name: stars[i].name || ("Star " + (i + 1)),
               residual_arcsec: residArcsec2
            });
            sipTotalResidSq += residArcsec2 * residArcsec2;
         }
         var sipRmsArcsec = Math.sqrt(sipTotalResidSq / nStars);

         if (sipMode === "interp") {
            // 補間モード: 星の正確な位置データから直接逆SIPを計算
            // forward SIP の多項式振動の影響を受けない直接計算法を使用
            var invSip = this._computeInverseSipDirect(
               [crval1, crval2], cd, uObs, vObs);
            if (invSip) {
               sipFit.ap = invSip.ap;
               sipFit.bp = invSip.bp;
               sipFit.invOrder = invSip.invOrder;
            }
            sipResult = sipFit;
            rmsArcsec = sipRmsArcsec;
            residuals = sipResiduals;
            pixelScaleArcsec = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) * 3600.0;
         } else {
            // 近似モード: 5%改善 + 0.1" 閾値
            if (sipRmsArcsec < tanRmsArcsec * 0.95 &&
                (tanRmsArcsec - sipRmsArcsec) > 0.1) {
               var uMin = 1 - crpix1, uMax = this.width - crpix1;
               var vMin = 1 - crpix2, vMax = this.height - crpix2;
               var invSip = this._computeInverseSip(sipFit.a, sipFit.b, sipFit.order,
                  [uMin, uMax], [vMin, vMax]);
               if (invSip) {
                  sipFit.ap = invSip.ap;
                  sipFit.bp = invSip.bp;
               }
               sipResult = sipFit;
               rmsArcsec = sipRmsArcsec;
               residuals = sipResiduals;
               pixelScaleArcsec = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) * 3600.0;
            }
         }
      }

      // Restore original TAN solution if SIP not accepted
      if (!sipResult) {
         cd[0][0] = tanCd[0][0]; cd[0][1] = tanCd[0][1];
         cd[1][0] = tanCd[1][0]; cd[1][1] = tanCd[1][1];
         crval1 = tanCrval1;
         crval2 = tanCrval2;
         sipMode = undefined;
      }
   }

   var sipInfo = sipResult ? " SIP" + sipResult.order : "";
   if (sipResult && sipMode === "interp") sipInfo += "i";
   return {
      success: true,
      crval1: crval1,
      crval2: crval2,
      crpix1: crpix1,
      crpix2: crpix2,
      cd: cd,
      sip: sipResult,
      sipMode: sipResult ? sipMode : undefined,
      pixelScale_arcsec: pixelScaleArcsec,
      rms_arcsec: rmsArcsec,
      rms_arcsec_tan: tanRmsArcsec,
      residuals: residuals,
      message: "WCS fit succeeded" + sipInfo + " (RMS: " + rmsArcsec.toFixed(2) + " arcsec, "
         + "pixel scale: " + pixelScaleArcsec.toFixed(3) + " arcsec/px)"
   };
};

//----------------------------------------------------------------------------
// Centroid computation (intensity-weighted center of gravity)
//
// Uses Image.sample(x, y, channel) in the PJSR environment.
// This function is PJSR-only.
//
//   image: PixInsight Image object
//   cx, cy: click position (0-based pixel coordinates)
//   radius: search radius in pixels (default 10)
//   Returns: {x, y} sub-pixel star center, or null on failure
//----------------------------------------------------------------------------
function computeCentroid(image, cx, cy, radius) {
   if (typeof radius === "undefined") radius = 10;

   var x0 = Math.max(0, Math.round(cx) - radius);
   var y0 = Math.max(0, Math.round(cy) - radius);
   var x1 = Math.min(image.width - 1, Math.round(cx) + radius);
   var y1 = Math.min(image.height - 1, Math.round(cy) + radius);

   // Use channel 0 (monochrome or R channel)
   var ch = 0;

   // Collect pixel values within the window for background estimation (median)
   var values = [];
   for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
         values.push(image.sample(x, y, ch));
      }
   }

   if (values.length === 0) return null;

   // Use median as background level
   values.sort(function (a, b) { return a - b; });
   var median = values[Math.floor(values.length / 2)];

   // Intensity-weighted centroid (background subtracted)
   var sumW = 0, sumWX = 0, sumWY = 0;
   for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
         var val = image.sample(x, y, ch) - median;
         if (val > 0) {
            sumW  += val;
            sumWX += val * x;
            sumWY += val * y;
         }
      }
   }

   if (sumW <= 0) return null;

   return {
      x: sumWX / sumW,
      y: sumWY / sumW
   };
}

// Export for Node.js environment (ignored in PJSR)
if (typeof module !== "undefined") {
   module.exports = {
      tanProject: tanProject,
      tanDeproject: tanDeproject,
      angularSeparation: angularSeparation,
      solveLinearSystem: solveLinearSystem,
      solveMinNorm: solveMinNorm,
      fitPolynomial2D: fitPolynomial2D,
      evalSipPolynomial: evalSipPolynomial,
      determineSipOrder: determineSipOrder,
      WCSFitter: WCSFitter,
      computeCentroid: computeCentroid
   };
}
