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

// SETTINGS_MODULE is required by AstronomicalCatalogs.jsh (Catalog base class)
#ifndef SETTINGS_MODULE
#define SETTINGS_MODULE "SPLITSOLVER"
#endif

// Include AdP dependencies.
// Relative path from src/scripts/SplitImageSolver/ to src/scripts/AdP/.
// Same pattern as BatchPreprocessing/BPP-Solver.js uses.
#include "../AdP/WCSmetadata.jsh"
#include "../AdP/AstronomicalCatalogs.jsh"

// Include ImageSolver in library mode (skips main(), UI, and redundant includes)
#define USE_SOLVER_LIBRARY true
#include "../AdP/ImageSolver.js"

#endif // __IMAGESOLVER_BRIDGE_JSH
