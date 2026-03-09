# Split Image Solver

[日本語版はこちら](README.ja.md)

A PixInsight script that splits wide-field astrophotos into tiles, plate-solves each tile, and merges the individual WCS solutions into a unified WCS for the entire image.

Handles ultra-wide-field images that PixInsight's built-in ImageSolver cannot solve.

> **Note**: For ultra-wide-field images (e.g., fisheye lenses), WCS accuracy may degrade near the edges. If you need higher precision, consider using [Manual Image Solver](https://github.com/ysmr3104/manual-image-solver), which lets you manually identify stars for fitting.

## Features

- **Two solve modes**: astrometry.net API (default) or local solve-field
- **Image preview with grid overlay**: Real-time tile split visualization with STF stretch (None/Linked/Unlinked)
- **Flexible tiling**: From 1x1 (single image) to 12x8, with one-click "Recommended" grid based on FOV
- **High accuracy**: SIP distortion correction, WCSFitter control-point fitting
- **Partial solve**: WCS can be computed even if some tiles fail
- **Two-pass retry**: Failed tiles are retried using WCS hints from successful neighbors
- **Overlap validation**: Automatic WCS consistency check across adjacent tiles
- **Equipment DB**: Auto-detection of camera/lens (with model numbers), auto-fill of focal length and pixel pitch
- **Fisheye support**: Equisolid / equidistant / stereographic projections with per-tile scale correction
- **Sesame name search**: Auto-fill RA/DEC from object names

## Solve Modes

| Mode | Description | Requirements |
|------|-------------|-------------|
| **API** (default) | Solve via astrometry.net API | API key only (no Python) |
| **Local** | Solve via local solve-field | Python + solve-field + star catalogs |

API mode works out of the box with no additional installation. For Local mode setup, see [docs/setup.md](docs/setup.md).

## Requirements

- **PixInsight 1.8.9+**
- **astrometry.net API key** (free, for API mode): https://nova.astrometry.net/

## Installation

### Option 1: PixInsight Repository (recommended)

1. Open PixInsight
2. Go to **Resources > Updates > Manage Repositories**
3. Add repository URL:
   ```
   https://ysmrastro.github.io/pixinsight-scripts/
   ```
4. Run **Resources > Updates > Check for Updates**
5. Install SplitImageSolver

### Option 2: Manual Installation

1. Clone or download:
   ```bash
   git clone https://github.com/ysmr3104/split-image-solver.git
   ```

2. Copy the following files from `javascript/` to the PixInsight scripts directory:
   ```
   SplitImageSolver.js
   astrometry_api.js
   wcs_math.js
   wcs_keywords.js
   equipment_data.jsh
   ```

   Script directory locations:
   - macOS: `/Applications/PixInsight/src/scripts/SplitImageSolver/`
   - Windows: `C:\Program Files\PixInsight\src\scripts\SplitImageSolver\`
   - Linux: `/opt/PixInsight/src/scripts/SplitImageSolver/`

3. Restart PixInsight
4. Run from **Script > Astrometry > SplitImageSolver**

## Screenshots

### Main Dialog

![Main Dialog](docs/images/main-dialog.jpg)

The left panel shows a real-time image preview with grid overlay visualizing how tiles will be split. STF stretch modes (None/Linked/Unlinked) are available below the preview. The right panel contains all parameters: equipment selection (auto-detected from FITS headers), split settings with a "Recommended" button for one-click optimal grid, and coordinate hints with Sesame name search.

### Settings Dialog

![Settings Dialog](docs/images/settings-dialog.jpg)

Access from the "Settings..." button at the bottom-left. Switch between solve modes (API / Local), configure API key, and set Python environment. Settings for both modes are always preserved.

## Usage

### Quick Start (Single Image)

1. Open the target image in PixInsight
2. Run **Script > Astrometry > SplitImageSolver**
3. Click **Settings...** and enter your API key (first time only; saved automatically)
4. Confirm the image preview on the left panel
5. Leave Grid at **1x1 (Single)** and click "Solve"
6. WCS is applied to the image upon completion

### Split Solve (Wide-Field)

1. Open the target image in PixInsight
2. Run **Script > Astrometry > SplitImageSolver**
3. Select **Camera/Lens** (auto-detected from FITS headers when available)
   - Focal length and pixel pitch are auto-filled
4. Click **Recommended** to set the optimal grid based on FOV
   - The preview updates in real-time showing the tile split overlay
5. Optionally enter an **object name** and click "Search" to fill RA/DEC
6. Click "Solve"

### Parameters

| Parameter | Description | Default | Mode |
|-----------|-------------|---------|------|
| Camera | Camera model (auto-fills pixel pitch) | Auto-detect | Both |
| Lens | Lens/telescope (auto-fills focal length) | Auto-detect | Both |
| Focal length | Focal length (mm). Manual input when equipment not in DB | Auto-fill | Both |
| Pixel pitch | Pixel pitch (μm). Manual input when camera not in DB | Auto-fill | Both |
| Scale Error | Scale estimation error (%) | 30 | API |
| Object | Object name (Sesame search) | — | Both |
| RA / DEC | Image center coordinates | — | Both |
| Radius | Search radius (°) | 10 | API |
| Grid | Split grid (ColsxRows) | 1x1 | Both |
| Overlap | Tile overlap (px) | 100 | Both |
| Downsample | Downsample setting | Auto | API |
| SIP Order | SIP distortion correction order | 4 | API |
| Timeout | Per-tile timeout (min) | 1 | API |

Parameters marked "API" are grayed out in Local mode (handled automatically by Python).

## Technical Details

See [docs/architecture.md](docs/architecture.md) for project structure, processing pipeline, and coding conventions.

## Troubleshooting

### API Login Failure

- Verify your API key: https://nova.astrometry.net/api_help
- Check internet connection

### Solve Takes Too Long / Fails

- **Enter RA/DEC hints**: Enter an object name and click Search to get coordinates — dramatically speeds up solving
- **Enter focal length / pixel pitch**: Select camera/lens or enter manually
- **Adjust grid**: Tiles that are too small may not contain enough stars

### Some Tiles Fail to Solve

- Tiles containing landscape or clouds cannot be solved (expected behavior)
- WCS merge is possible with 2+ successful tiles
- Failed tiles are automatically retried in Pass 2

### Low WCS Accuracy

- Increase overlap (100 → 200px)
- Increase SIP Order (2 → 4)
- Use a finer grid

### Local Mode: Python Not Found

- Verify the Python path in Settings
- For .venv, enter the full path: `/path/to/.venv/bin/python3`
- Verify solve-field is installed and in PATH

## License

MIT License

## References

- [Astrometry.net](https://astrometry.net/) — Plate solver
- [Astrometry.net API](https://nova.astrometry.net/api_help) — API documentation
- [PixInsight](https://pixinsight.com/) — Astronomical image processing software
- [FITS WCS Standard](https://fits.gsfc.nasa.gov/fits_wcs.html) — FITS WCS specification
