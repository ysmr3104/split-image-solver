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
brew install astrometry-net netpbm
```

- `netpbm` provides the `pnmfile` command used internally by `solve-field` (**required**)
- `solve-field` will not work correctly without `netpbm`

### Linux (Ubuntu/Debian)

```bash
sudo apt install astrometry.net astrometry-data-tycho2
```

### Build from Source

```bash
# Install dependencies
sudo apt-get install libcfitsio-dev libcairo2-dev python3-dev \
  libjpeg-dev libnetpbm-dev netpbm wcslib-dev zlib1g-dev

# Clone and build
git clone https://github.com/dstndstn/astrometry.net.git
cd astrometry.net
make
make install
```

## 3. Star Catalogs (Index Files)

solve-field requires index files matching the field of view (FOV) of your images. **This is the most common setup issue.**

### astrometry.cfg

solve-field reads `astrometry.cfg` to find index file locations. Check the `addpath` setting:

```bash
# macOS (Homebrew)
cat /opt/homebrew/etc/astrometry.cfg | grep addpath
# Output example: addpath /opt/homebrew/share/astrometry/data
```

Index files must be placed in the directory specified by `addpath`.

> **Tip**: After Homebrew upgrades, the `addpath` may point to a versioned path (e.g., `/opt/homebrew/Cellar/astrometry-net/0.97/data`) that no longer exists. Use the symlinked path `/opt/homebrew/share/astrometry/data` instead.

### Lens Focal Length vs Index Files

| Lens Focal Length | FOV (Full Frame) | Tile FOV (3x3 split) | Required Index |
|------------------|-----------------|---------------------|----------------|
| 24mm | ~74° | ~26° | 4110 ~ 4119 |
| 35mm | ~54° | ~19° | 4110 ~ 4119 |
| 50mm | ~40° | ~14° | 4112 ~ 4118 |
| 85mm | ~24° | ~9° | 4115 ~ 4119, 4200 series |
| 135mm | ~15° | ~6° | 4200 series |

**Important**: Choose index files based on the **tile FOV** (after splitting), not the full image FOV.

### Index Series Overview

Official index files are available at http://data.astrometry.net/

| Index Series | FOV Range | Size | Use Case |
|-------------|-----------|------|----------|
| 4100 (index-4110 ~ 4119) | 30' ~ 1° (tile FOV 6° ~ 22°) | ~200MB/file | Wide-angle lenses |
| 4200 (index-4200 ~ 4219) | 2' ~ 2.8° (tile FOV ~6°) | ~40MB/file | Medium telephoto |
| 5200 (Tycho-2) | 7' ~ 19' | ~1GB total | Telescopes |

### Download (macOS)

```bash
# 1. Check the addpath directory
cat /opt/homebrew/etc/astrometry.cfg | grep addpath

# 2. Navigate to that directory
cd /opt/homebrew/share/astrometry/data

# 3. Download index files

# For wide-angle lenses (24-50mm): 4100 series
for i in $(seq 4110 4119); do
  curl -O http://data.astrometry.net/4100/index-${i}.fits
done

# For medium telephoto (85mm+): add 4200 series
for i in $(seq 4200 4219); do
  curl -O http://data.astrometry.net/4200/index-${i}.fits
done
```

### Download (Linux)

```bash
cd /usr/share/astrometry/
for i in $(seq 4110 4119); do
  sudo wget http://data.astrometry.net/4100/index-${i}.fits
done
```

### Verify Installation

```bash
# Check solve-field works
solve-field --help

# Verify index files exist
ls /opt/homebrew/share/astrometry/data/index-41*.fits
```

## 4. PixInsight Configuration

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

## Troubleshooting

### solve-field not found

```
FileNotFoundError: solve-field command not found
```

Install via `brew install astrometry-net` (macOS) or `sudo apt install astrometry.net` (Linux).

### No index files found / All tile solves failed

```bash
# 1. Check addpath in astrometry.cfg
cat /opt/homebrew/etc/astrometry.cfg | grep addpath

# 2. Verify index files exist in that directory
ls /opt/homebrew/share/astrometry/data/index-*.fits

# 3. If missing, download (see above)

# 4. If addpath points to a non-existent directory, edit astrometry.cfg
```

### pnmfile not found

```
pnmfile: command not found
```

Install `netpbm`:

```bash
brew install netpbm    # macOS
sudo apt install netpbm  # Linux
```
