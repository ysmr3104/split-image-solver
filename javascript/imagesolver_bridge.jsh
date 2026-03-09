// ============================================================================
// imagesolver_bridge.jsh
//
// Bridge file for using PixInsight's built-in ImageSolver as a library.
// This file includes the necessary AdP scripts and provides ImageSolver()
// constructor for use by SplitImageSolver.
//
// Copyright (c) 2012-2024 Andres del Pozo, Juan Conejero (PTeam)
// ImageSolver is distributed under BSD 2-Clause License.
// See the original source files for full license text.
//
// Copyright (c) 2026 Split Image Solver Project (bridge integration)
// ============================================================================

#ifndef __IMAGESOLVER_BRIDGE_JSH
#define __IMAGESOLVER_BRIDGE_JSH

// STAR_CSV_FILE is required by ImageSolver for StarAlignment
#ifndef STAR_CSV_FILE
#define STAR_CSV_FILE (File.systemTempDirectory + format("/stars-%03d.csv", CoreApplication.instance))
#endif

// Include AdP dependencies.
// These paths resolve via PixInsight's standard scripts include path.
//
// If the includes fail, replace "AdP/..." with the full absolute path:
//   macOS:   "/Applications/PixInsight/src/scripts/AdP/..."
//   Linux:   "/opt/PixInsight/src/scripts/AdP/..."
//   Windows: "C:/Program Files/PixInsight/src/scripts/AdP/..."

// macOS absolute paths. Adjust for your platform if needed:
//   Linux:   /opt/PixInsight/src/scripts/AdP/...
//   Windows: C:/Program Files/PixInsight/src/scripts/AdP/...
#include "/Applications/PixInsight/src/scripts/AdP/WCSmetadata.jsh"
#include "/Applications/PixInsight/src/scripts/AdP/AstronomicalCatalogs.jsh"

// Include ImageSolver in library mode (skips main(), UI, and redundant includes)
#define USE_SOLVER_LIBRARY true
#include "/Applications/PixInsight/src/scripts/AdP/ImageSolver.js"

#endif // __IMAGESOLVER_BRIDGE_JSH
