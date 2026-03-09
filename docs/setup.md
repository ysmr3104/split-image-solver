# Local Mode Setup

Local mode uses a local `solve-field` installation instead of the astrometry.net API. This requires additional setup.

## Prerequisites

- **Python 3.8+** (with astropy, scipy, numpy)
- **astrometry.net solve-field** + star catalogs (several GB)

## 1. Python Environment

```bash
# Clone the repository
git clone https://github.com/ysmr3104/split-image-solver.git
cd split-image-solver

# Create and activate a Python virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install astropy scipy numpy
```

## 2. Install solve-field

### macOS (Homebrew)

```bash
brew install astrometry-net
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install astrometry.net astrometry-data-tycho2
```

Star catalog (index files) download is also required. See the [astrometry.net documentation](http://astrometry.net/doc/readme.html) for details.

## 3. PixInsight Configuration

1. Run **Script > Astrometry > SplitImageSolver**
2. Click the **Settings...** button at the bottom-left
3. Change **Solve Mode** to "Local (solve-field)"
4. In the **Local Settings** section, configure:
   - **Python**: Path to the Python executable (e.g., `/path/to/split-image-solver/.venv/bin/python3`)
     - Python inside .venv may not be visible from Finder; enter the path directly
   - **Script directory**: Path to the split-image-solver repository (e.g., `/path/to/split-image-solver`)
5. Click "OK"

Settings are persisted. The script will automatically start in Local mode on subsequent launches. To switch back to API mode, simply change the Mode in Settings.

## Notes

- In Local mode, Downsample / SIP Order / Timeout / Radius / Scale Error are grayed out (handled automatically by Python)
- Focal length / Pixel pitch are available in both modes (for manual input when equipment is not in the DB)
- Settings for both modes (API key and Python environment) are always preserved regardless of which mode is selected
