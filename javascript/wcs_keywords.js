//============================================================================
// wcs_keywords.js - FITS WCS keyword utilities
//
// Shared by ManualImageSolver.js and WCSApplier.js via #include.
// PJSR-only (requires FITSKeyword class).
//
// Copyright (c) 2026 Manual Image Solver Project
//============================================================================

// Check if a FITS keyword name is WCS-related
function isWCSKeyword(name) {
   var wcsNames = [
      "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2",
      "CD1_1", "CD1_2", "CD2_1", "CD2_2",
      "CDELT1", "CDELT2", "CROTA1", "CROTA2",
      "CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2",
      "RADESYS", "EQUINOX",
      "A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER",
      "PLTSOLVD",
      "OBJCTRA", "OBJCTDEC"
   ];
   for (var i = 0; i < wcsNames.length; i++) {
      if (name === wcsNames[i]) return true;
   }
   if (/^[AB]P?_\d+_\d+$/.test(name)) return true;
   return false;
}

// Determine FITSKeyword type from value and create the appropriate FITSKeyword object
function makeFITSKeyword(name, value) {
   var strVal = value.toString();
   if (strVal === "T" || strVal === "true") {
      return new FITSKeyword(name, "T", "");
   }
   if (strVal === "F" || strVal === "false") {
      return new FITSKeyword(name, "F", "");
   }
   var stringKeys = ["CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2", "RADESYS",
      "OBJCTRA", "OBJCTDEC"];
   for (var i = 0; i < stringKeys.length; i++) {
      if (name === stringKeys[i]) {
         return new FITSKeyword(name, "'" + strVal + "'", "");
      }
   }
   return new FITSKeyword(name, strVal, "");
}
