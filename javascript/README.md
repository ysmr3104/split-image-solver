# Split Image Solver - PixInsight Script

Automatic plate solver for PixInsight using astrometry.net API or local solve-field.
Supports single-image and split-tile solving for wide-field astrophotos.

For full documentation, see the [project README](../README.md) ([日本語](../README.ja.md)).

## Files

| File | Description |
|------|-------------|
| `SplitImageSolver.js` | Main script (UI + solve engine) |
| `astrometry_api.js` | astrometry.net API client |
| `wcs_math.js` | WCS math library (TAN projection, SIP fitting, etc.) |
| `wcs_keywords.js` | FITS keyword utilities |
| `equipment_data.jsh` | Equipment database (cameras + lenses) |

All files must be placed in the same directory. `SplitImageSolver.js` loads the others via `#include`.

## Screenshots

### Main Dialog

![Main Dialog](../docs/images/main-dialog.jpg)

### Settings Dialog

![Settings Dialog](../docs/images/settings-dialog.jpg)

## Quick Install

### Via PixInsight Repository (recommended)

1. **Resources > Updates > Manage Repositories**
2. Add URL: `https://ysmrastro.github.io/pixinsight-scripts/`
3. **Check for Updates** → Install SplitImageSolver

### Manual

Copy all 5 files to the PixInsight scripts directory:

```
{PixInsight}/src/scripts/SplitImageSolver/
```

- macOS: `/Applications/PixInsight/src/scripts/SplitImageSolver/`
- Windows: `C:\Program Files\PixInsight\src\scripts\SplitImageSolver\`
- Linux: `/opt/PixInsight/src/scripts/SplitImageSolver/`

After restart: **Script > Astrometry > SplitImageSolver**

## Grid Size Guidelines

| Diagonal FOV | Recommended Grid | Example |
|-------------|-----------------|---------|
| ~10° | 1x1 | Telescope |
| ~30° | 2x2 | 200mm lens |
| ~60° | 3x3 | 35-50mm lens |
| ~90° | 4x4 | 24mm lens |
| ~120° | 6x4 | 14-20mm lens |
| 120°+ | 8x6+ | Fisheye lens |
