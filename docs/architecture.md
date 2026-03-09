# Architecture

## Project Structure

```
split-image-solver/
├── javascript/
│   ├── SplitImageSolver.js    — Main script (UI + engine + Local mode integration)
│   │   ├── SolverSettingsDialog  — Settings dialog (mode switch, API key, Python env)
│   │   └── SplitSolverDialog     — Main dialog (equipment, grid, coordinates, solve)
│   ├── astrometry_api.js      — astrometry.net API client (via curl)
│   ├── wcs_math.js            — WCS math library (shared with manual-image-solver)
│   ├── wcs_keywords.js        — FITS keyword utilities (shared)
│   └── equipment_data.jsh     — Equipment DB (cameras + lenses, with model numbers)
├── python/                    — Local mode Python implementation
├── build-split-release.sh     — Release build script
├── repository/                — PixInsight repository distribution package
├── tests/                     — Tests
└── docs/                      — Documentation
```

## Solve Modes

- **API mode** (default): PJSR only. Communicates with astrometry.net API via ExternalProcess + curl. No Python required.
- **Local mode**: PJSR calls Python `main.py` via ExternalProcess. Uses local solve-field for solving.

## Processing Pipeline

### API Mode — Single Image (1x1)

1. Export image to FITS → upload to astrometry.net API
2. Wait for solve completion → download calibration + WCS FITS
3. Parse WCS parameters → WCSFitter for CD matrix + SIP fitting
4. Apply FITS keywords + control points to image

### API Mode — Split Solve (NxM)

1. Split image into NxM tiles with overlap (FITS temp save + downsample)
2. Pass 1: Solve all tiles via API
3. Pass 2: Retry failed tiles using WCS hints from successful neighbors (`retryFailedTiles`)
4. Overlap validation: Check WCS consistency between adjacent tiles (`validateOverlap`)
5. Collect control points from all successful tiles → generate unified WCS via WCSFitter (`mergeWcsSolutions`)
6. Apply unified WCS to the original image

### Local Mode

1. Save image to temporary XISF (with FITS metadata)
2. Execute Python `main.py` via ExternalProcess (`--grid`, `--overlap`, `--ra`, `--dec`, etc.)
3. Display stderr in real-time (progress label + Abort button support)
4. Parse result JSON (`--result-file`) to get `wcs_keywords`
5. Apply FITS keywords directly to image + `regenerateAstrometricSolution()`

## Key Modules

- **`SplitImageSolver.js`** — Main script. Contains `SolverSettingsDialog` (settings), `SplitSolverDialog` (main UI), tile splitting (`splitImageToTiles`), tile solving (`solveMultipleTiles`), two-pass retry (`retryFailedTiles`), overlap validation (`validateOverlap`), WCS merge (`mergeWcsSolutions`), WCS application (`applyWCSToImage`, `setCustomControlPoints`), and Local mode execution (`doLocalSolve`).
- **`astrometry_api.js`** — `AstrometryClient` class. Calls astrometry.net API via ExternalProcess + curl (login → upload → pollSubmission → pollJob → getCalibration → getWcsFile).
- **`wcs_math.js`** — WCS math library. `WCSFitter` (CD matrix + SIP fitting), `tanProject`/`tanDeproject` (TAN projection), `pixelToRaDec`/`raDecToPixel`, `angularSeparation`, etc. Shared with manual-image-solver. Compatible with both PJSR and Node.js.
- **`wcs_keywords.js`** — FITS WCS keyword utilities (`isWCSKeyword`, `makeFITSKeyword`).
- **`equipment_data.jsh`** — Equipment database (66 cameras + 48 lenses/telescopes). Cameras have `instrume` (model ID) field; lenses have `model` field.

## Settings Persistence (Settings API)

| Key | Type | Description |
|-----|------|-------------|
| `SplitImageSolver/solveMode` | String | `"api"` or `"local"` |
| `SplitImageSolver/apiKey` | String | astrometry.net API key |
| `SplitImageSolver/pythonPath` | String | Python executable path |
| `SplitImageSolver/scriptDir` | String | split-image-solver repository path |
| `SplitImageSolver/pixelScale` | Double | Last used pixel scale |
| `SplitImageSolver/camera` | String | Last selected camera name |
| `SplitImageSolver/lens` | String | Last selected lens name |

## Coding Conventions

- **ES5 style required**: PJSR does not support `let`/`const`/arrow functions/template literals. Use `var` declarations only.
- Variable names, function names, comments, and console output (`console.writeln`) are all in English.
- UI text (labels, message boxes) may use Japanese.

## Tests

```bash
# Node.js unit tests (pure functions from SplitImageSolver)
node tests/javascript/test_split_solver.js

# Release build (PixInsight repository package)
bash build-split-release.sh

# Python tests (for Local mode)
PYTHONPATH="." .venv/bin/pytest tests/python -v
```

## External Dependencies

- **PixInsight 1.8.9+** — PJSR script runtime
- **astrometry.net API key** — https://nova.astrometry.net/ (free, for API mode)
- **curl** — HTTP communication (OS built-in, for API mode)
- **Python 3.8+** — For Local mode (astropy, scipy, numpy)
- **solve-field** — For Local mode (astrometry.net local version)
- Node.js — For running tests (optional)
