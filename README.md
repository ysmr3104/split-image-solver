# Split Image Solver

広角星野写真を分割してプレートソルブし、統合したWCS座標情報を元画像に適用するツールです。

PixInsightの ImageSolver では対応できない超広角な範囲の星空画像に対応します。

## 特徴

- **柔軟な分割**: 2x2, 3x3, 2x4など、任意のグリッドパターンで画像を分割
- **高精度**: オーバーラップ領域での整合性検証により高精度なWCS統合
- **並列処理**: 複数の分割画像を並列でプレートソルブし、処理時間を短縮
- **XISF/FITS対応**: PixInsightネイティブのXISF形式とFITS形式の両方に完全対応
- **自動形式判定**: 入力ファイルの形式を自動判定し、同じ形式で出力

## 必要な環境

### 必須ソフトウェア

- **Python 3.8以降**
- **ASTAP** (Astrometric Stacking Program)
  - ダウンロード: https://www.hnsky.org/astap.htm
  - 星データベースも必要（約2GB）
- **PixInsight 1.8.9以降** (PixInsight統合を使用する場合)

### Python依存ライブラリ

```bash
pip install -r requirements.txt
```

主な依存関係:
- numpy >= 1.21.0
- astropy >= 5.0.0
- scipy >= 1.7.0
- Pillow >= 9.0.0
- xisf >= 0.2.0 (XISF形式サポート)
- lxml >= 4.9.0 (XISF形式サポート)

## インストール

### 前提条件

**必須:**
- Python 3.8以上（推奨: Python 3.10以上）
- ASTAP (Astrometric Stacking Program)
- 十分なディスク容量（ASTAPデータベース用に約2-5GB）

**動作確認済み環境:**
- macOS 14.x (Apple Silicon M1/M2)
- Python 3.14
- ASTAP for macOS

### 簡単インストール（Makefile使用・推奨）

```bash
# 1. リポジトリをクローン
git clone https://github.com/yourusername/split-image-solver.git
cd split-image-solver

# 2. 開発環境を一括セットアップ
make install-dev

# 3. 設定ファイルを作成して編集
cp config/settings.example.json config/settings.json
# config/settings.json を編集してASTAPのパスを設定

# 4. ASTAPのインストール確認
make check-astap
```

### ASTAPのインストールと設定

**macOSの場合:**

1. ASTAPをダウンロード: https://www.hnsky.org/astap.htm
2. ASTAP.appをアプリケーションフォルダにインストール
3. ASTAPを一度起動してGUIからデータベースをインストール
   - メニュー: Settings → Star Database
   - 推奨データベース:
     - D50 (Deep sky, 0-30°) - 約1.5GB
     - W08 (Wide field, 0.25-2°) - 約500MB

4. コマンドラインから実行テスト:
   ```bash
   /Applications/ASTAP.app/Contents/MacOS/astap -h
   ```

**データベースの選択基準:**

- **D50**: 焦点距離 200mm以上（視野 0-5°程度）
- **W08**: 焦点距離 50-200mm（視野 2-30°程度）
- **G05**: 超広角（視野 30°以上） - オプション

複数のデータベースをインストールすると、ASTAPが自動的に適切なものを選択します。

### 手動インストール

1. リポジトリをクローン:

```bash
git clone https://github.com/yourusername/split-image-solver.git
cd split-image-solver
```

2. Python仮想環境を作成:

```bash
python3 -m venv .venv
source .venv/bin/activate  # Linux/Mac
# または
.venv\Scripts\activate  # Windows
```

3. Python依存関係をインストール:

```bash
pip install -r requirements.txt
```

4. ASTAPをインストール（未インストールの場合）:
   - https://www.hnsky.org/astap.htm からダウンロード
   - 星データベースもダウンロードして配置

5. 設定ファイルを作成:

```bash
cp config/settings.example.json config/settings.json
```

6. `config/settings.json` を編集してASTAPのパスを設定:

```json
{
  "astap": {
    "executable_path": "/usr/local/bin/astap",
    "database_path": "/usr/local/share/astap"
  }
}
```

## 使い方

### Makefileコマンド（推奨）

便利なMakefileコマンドが用意されています：

```bash
# ヘルプを表示
make help

# プロジェクト情報を表示
make info

# 開発環境をセットアップ
make install-dev

# ASTAPのインストール確認
make check-astap

# テストを実行
make test

# コードをフォーマット
make format

# クリーンアップ
make clean
```

### コマンドライン（Python）

基本的な使い方:

```bash
python3 python/main.py \
  --input input_image.fits \
  --output output_image.fits \
  --grid 2x2 \
  --overlap 100 \
  --astap-path /usr/local/bin/astap
```

#### オプション

**必須:**
- `--input PATH`: 入力FITS画像パス
- `--output PATH`: 出力FITS画像パス

**分割設定:**
- `--grid NxM`: 分割グリッドパターン (例: 2x2, 3x3, 2x4) [デフォルト: 2x2]
- `--overlap NUM`: オーバーラップピクセル数 [デフォルト: 100]

**ASTAP設定:**
- `--astap-path PATH`: ASTAP実行ファイルパス
- `--astap-db PATH`: ASTAP星データベースパス
- `--astap-timeout SEC`: タイムアウト秒数 [デフォルト: 300]

**WCS統合設定:**
- `--wcs-method METHOD`: 統合方法 (weighted_least_squares | central_tile) [デフォルト: weighted_least_squares]
- `--overlap-tolerance NUM`: オーバーラップ検証の許容誤差（秒角） [デフォルト: 5.0]

**その他:**
- `--temp-dir PATH`: 一時ファイルディレクトリ
- `--keep-temp`: 一時ファイルを保持
- `--log-level LEVEL`: ログレベル (DEBUG | INFO | WARNING | ERROR) [デフォルト: INFO]
- `--log-file PATH`: ログファイルパス
- `--config PATH`: 設定ファイルパス [デフォルト: ./config/settings.json]

### 使用例

**例1: 2x2分割で処理**

```bash
python3 python/main.py \
  --input wide_field_image.fits \
  --output solved_image.fits \
  --grid 2x2 \
  --overlap 100
```

**例2: 3x3分割、詳細ログ出力**

```bash
python3 python/main.py \
  --input ultra_wide_image.fits \
  --output solved_ultra_wide.fits \
  --grid 3x3 \
  --overlap 150 \
  --log-level DEBUG \
  --log-file solver.log
```

**例3: 2x4分割（横長画像）**

```bash
python3 python/main.py \
  --input panorama_image.fits \
  --output solved_panorama.fits \
  --grid 2x4 \
  --overlap 200
```

**例4: XISF形式の画像を処理**

```bash
python3 python/main.py \
  --input pixinsight_image.xisf \
  --output solved_image.xisf \
  --grid 2x2 \
  --overlap 100
```

XISF形式の場合、WCS情報はFITSキーワードとXISFプロパティの両方に保存されます。PixInsightで完全に互換性があります。

### PixInsight統合（今後実装予定）

JavaScriptスクリプトをPixInsightのスクリプトメニューから実行:

1. PixInsightで画像を開く
2. Script > Execute Script File...
3. `javascript/SplitImageSolver.js` を選択
4. パラメータを設定して実行

## アルゴリズム

### 処理フロー

1. **画像分割**: 元画像を指定されたグリッドパターンで分割
   - オーバーラップ領域を含めて分割
   - 各分割画像の位置情報をFITSヘッダーに記録

2. **プレートソルブ**: 各分割画像に対してASTAPを実行
   - 並列処理で高速化
   - WCS情報を各分割画像のFITSヘッダーに取得

3. **WCS座標変換**: 分割画像のWCSを元画像座標系に変換
   - CRPIX（参照ピクセル座標）をオフセット調整
   - CD matrix（スケール+回転）は維持

4. **整合性検証**: オーバーラップ領域でのWCS整合性を確認
   - 隣接する分割画像間で座標を比較
   - 角距離の誤差を計算

5. **WCS統合**: 全分割画像のWCSから最適な元画像WCSを計算
   - 重み付き最小二乗法で制御点から推定
   - 画像中心に近いほど高重み

6. **WCS書き込み**: 統合したWCS情報を元画像のFITSヘッダーに書き込み

### WCS統合アルゴリズム

**重み付き最小二乗法:**

1. 各分割画像から制御点を抽出（グリッド点）
2. 制御点の天球座標を計算
3. 重み付け:
   - 画像中心からの距離: 中心に近いほど高重み
   - ソルブ時間: 速いほど高品質と判断
   - ピクセルスケールの存在
4. scipy.optimize.least_squares で WCS パラメータ（CRVAL, CD matrix）を最適化

## プロジェクト構造

```
split-image-solver/
├── config/
│   ├── settings.json              # 設定ファイル
│   └── settings.example.json      # 設定例
├── python/
│   ├── main.py                    # メインスクリプト
│   ├── image_splitter.py          # 画像分割
│   ├── astap_solver.py            # ASTAP統合
│   ├── wcs_integrator.py          # WCS座標統合
│   ├── fits_handler.py            # FITSヘッダー操作
│   └── utils/
│       └── logger.py              # ロギング
├── javascript/                    # PixInsight統合（今後実装）
├── tests/                         # テスト
├── requirements.txt               # Python依存関係
└── README.md
```

## トラブルシューティング

### ASTAPが見つからない

```
FileNotFoundError: ASTAP executable not found
```

**解決方法:**
- ASTAPがインストールされているか確認
- `--astap-path` オプションで正しいパスを指定
- または `config/settings.json` で設定

**macOSの場合:**

```bash
# ASTAP.appがインストールされているか確認
ls -lh /Applications/ASTAP.app/Contents/MacOS/astap

# config/settings.jsonに設定
{
  "astap": {
    "executable_path": "/Applications/ASTAP.app/Contents/MacOS/astap"
  }
}
```

### すべてのタイルのソルブに失敗

```
All tile solves failed
```

**原因と解決方法:**
- **星が少ない**: より大きなタイルサイズ（少ない分割数）を試す
- **視野が広すぎる**: 分割数を増やす
- **ピクセルスケールが不明**: 画像のFITSヘッダーにピクセルスケール情報を追加
- **ASTAP データベース未設定**: `--astap-db` でデータベースパスを指定

#### 詳細なデバッグ手順

1. **一時ファイルを保持して確認**

   ```bash
   .venv/bin/python3 python/main.py \
     --input input.xisf \
     --output output.xisf \
     --grid 2x2 \
     --pixel-scale 3.83 \
     --temp-dir /tmp/solver_test \
     --keep-temp
   ```

2. **保存されたタイルファイルを確認**

   ```bash
   # 一時ディレクトリは実行時のログに表示される
   ls -lh /tmp/solver_test/split_solver_YYYYMMDD_HHMMSS/splits/
   ```

3. **ASTAPを手動で実行してエラー確認**

   ```bash
   /Applications/ASTAP.app/Contents/MacOS/astap \
     -f /tmp/solver_test/.../splits/tile_00_00.fits \
     -fov 2.4
   ```

4. **ASTAPのヘルプを確認**

   ```bash
   /Applications/ASTAP.app/Contents/MacOS/astap -h
   ```

5. **XISFメタデータから正確なパラメータを抽出**

   ```python
   import xisf
   xf = xisf.XISF("input.xisf")
   metadata = xf.get_images_metadata()[0]
   # FOCALLEN, XPIXSZ, RA, DECなどを確認
   ```

6. **ピクセルスケールの計算**

   ```python
   pixel_scale = 206.265 * pixel_size_um / focal_length_mm
   # 例: 206.265 * 4.63 / 249.34 = 3.83 arcsec/pixel
   ```

### 実行成功例（2026-02-06）

**テスト画像:**

- ファイル: `masterLight_BIN-1_4144x2822_EXPOSURE-300.00s_FILTER-HO3_RGB.xisf`
- 対象: M31（アンドロメダ銀河）
- カメラ: ZWO ASI294MC Pro
- 焦点距離: 249.34mm
- ピクセルサイズ: 4.63μm
- 実測ピクセルスケール: 3.83 arcsec/pixel
- 最終WCS中心座標: RA=10.6952°, Dec=41.2596°

**実行コマンド:**

```bash
.venv/bin/python3 python/main.py \
  --input "/Users/yossy/Downloads/masterLight_BIN-1_4144x2822_EXPOSURE-300.00s_FILTER-HO3_RGB.xisf" \
  --output "/Users/yossy/Downloads/test_solved_m31.xisf" \
  --grid 2x2 \
  --overlap 200 \
  --keep-temp \
  --temp-dir /tmp/solver_test
```

**実行結果:**

```
[Step 1/6] Loading input image...
XISF loaded: shape=(2822, 4144, 3), dtype=float32, fits_keywords=61

[Step 2/6] Splitting image...
Splitting image into 4 tiles (format: XISF)...
Image splitting completed: 4 tiles saved

[Step 3/6] Plate solving tiles with ASTAP...
Calculated from FOCALLEN=249.34mm: pixel_scale=7.17 arcsec/pixel, estimated tile FOV=4.5° (not used as hint)
Starting batch ASTAP solve: 4 images, 4 workers
ASTAP solve successful: RA=11.5424°, Dec=40.2621°, scale=3.83"/pix, time=1.4s
ASTAP solve successful: RA=11.5639°, Dec=42.2530°, scale=3.83"/pix, time=1.4s
ASTAP solve successful: RA=9.8540°, Dec=40.2598°, scale=3.83"/pix, time=1.4s
ASTAP solve successful: RA=9.8232°, Dec=42.2508°, scale=3.83"/pix, time=1.4s
Batch solve completed: 4/4 successful

[Step 4/6] Collecting WCS information...
Collected WCS from 4 tiles

[Step 5/6] Integrating WCS...
WCS optimization completed: RA=10.6952°, Dec=41.2596°, scale=1.06"/pix

[Step 6/6] Writing WCS to output image...
WCS written to XISF: /Users/yossy/Downloads/test_solved_m31.xisf

Split Image Solver - Completed Successfully
```

**処理時間:**
- 画像読み込み: 0.2秒
- 画像分割: 0.3秒
- プレートソルブ（4タイル並列）: 1.4秒
- WCS統合: 4.7秒
- 出力書き込み: 0.3秒
- **合計: 約9秒**

**出力ファイル:**

出力XISFファイルには以下のWCS情報が含まれます：

```
CRVAL1: 10.695226 (RA of reference point)
CRVAL2: 41.259564 (Dec of reference point)
CRPIX1: 2073.0 (Reference pixel X)
CRPIX2: 1412.0 (Reference pixel Y)
CD1_1: -1.874e-06 (Transformation matrix)
CD1_2: -8.223e-05
CD2_1: 1.064e-03
CD2_2: -1.315e-07
CTYPE1: RA---TAN (Coordinate type)
CTYPE2: DEC--TAN
PLTSOLVD: T (Plate solved flag)
```

### オーバーラップ検証失敗

```
Overlap validation failed: max error = 10.5" (tolerance = 5.0")
```

**原因と解決方法:**
- **広角レンズの歪み**: 許容誤差を増やす (`--overlap-tolerance 15`)
- **ソルブの精度不足**: より多くの星が含まれるようタイルサイズを調整
- **注意**: 検証失敗でも処理は続行されますが、結果の精度が低い可能性があります

**実例:**

M31画像（4144x2822, 2x2分割）では以下の警告が出ましたが、最終的なWCS統合は成功しました：

```
Overlap validation: mean=5423.36", max=9277.29", RMS=7091.96", consistent=False
WARNING: Overlap validation failed: max error = 9277.29" (tolerance = 5.0")
WARNING: Proceeding anyway, but results may be inaccurate
```

この大きな誤差は、個々のタイルのWCS解が完全に正確ではないためですが、重み付き最小二乗法による統合で補正されます。

### XISF読み込みエラー

**問題1: xisfライブラリのインストール**

```
ModuleNotFoundError: No module named 'xisf'
```

**解決方法:**

```bash
pip install xisf lxml
```

**問題2: FITSキーワードの型エラー**

```
TypeError: 'int' object is not iterable
```

これは古いバージョンのコードで発生していた問題です。現在のバージョンでは修正済みです。

**問題3: WCS読み取りエラー**

```
Failed to read WCS from solved image: WCS has no celestial coordinates
```

**原因:**
ASTAPはXISFファイルに直接WCS情報を書き込まず、`.ini`ファイルにのみ出力します。

**解決方法:**
現在のバージョンでは`.ini`ファイルからWCS情報を読み取るように実装されています。

### FOVヒントの実装（2026-02-06更新）

**現在の実装状況:**

FOVヒント機能は**有効**になっており、分割後のタイルサイズに応じて適切なFOVがASTAPに渡されます：

```python
# main.pyの実装
tile_width_pixels = split_files[0]['region']['x_end'] - split_files[0]['region']['x_start']
tile_fov = (pixel_scale * tile_width_pixels) / 3600.0  # arcsec -> degrees
fov_hint = tile_fov  # タイルサイズに応じたFOVヒントを使用
```

**動作確認:**
- 2x2分割: タイルFOV 30.3° → ASTAPに正しく渡される ✓
- 4x4分割: タイルFOV 15.6° → ASTAPに正しく渡される ✓
- 6x6分割: タイルFOV 10.7° → ASTAPに正しく渡される ✓

**注意事項:**
FOVヒントを指定しても、ASTAP自身が画像を解析して最適な検索窓を決定するため、指定したFOVより小さい検索窓が使われることがあります。これは正常な動作です。

### 超広角フィールド（35mm以下）の制限

**テスト結果（2026-02-06）:**

35mmレンズで撮影された超広角フィールド画像（ピクセルスケール: 35 arcsec/pixel）でASTAPによるプレートソルブを試みましたが、すべてのデータベースで失敗しました。

**テスト画像:**
- レンズ: 35mm（Sony α7III）
- 画像サイズ: 6024x4024
- ピクセルスケール: 35 arcsec/pixel
- 全視野: 54° x 38°
- 対象: バラ星雲付近

**テストしたデータベースと結果:**

| データベース | 対応FOV範囲 | テスト分割 | タイルFOV | 結果 |
|------------|------------|----------|---------|------|
| D50 | 0-5° | 6x6 | 10.7° | ❌ 失敗 |
| D20 | 5-20° | 4x4 | 15.6° | ❌ 失敗 |
| W08 | 2-30° | 2x2 | 30.3° | ❌ 失敗 |
| V05 | 広視野 | 4x4 | 15.6° | ❌ 失敗 |

**失敗の原因:**
```
Using star database V05
525 stars, 419 quads selected in the image
362 database stars, 289 database quads required
No solution found!  :(
```

星は検出されているものの、ピクセルスケールが粗すぎる（35 arcsec/pixel）ため、星のパターンマッチングが成功しません。

**推奨される対処法:**

1. **より長い焦点距離で撮影**
   - 推奨: 50mm以上（ピクセルスケール < 20 arcsec/pixel）
   - 理想: 100mm以上（ピクセルスケール < 10 arcsec/pixel）

2. **Astrometry.netの使用を検討**
   - ASTAPより広視野・粗いピクセルスケールに強い
   - 処理時間は長いが成功率が高い可能性
   - 今後の実装予定

3. **ビニング・リサンプリングは効果なし**
   - 画像を縮小しても星のパターンは変わらないため効果なし

**動作が確認されている範囲:**
- ピクセルスケール: 3.83 arcsec/pixel（焦点距離: 249mm）✓
- 焦点距離: 50mm以上を推奨

### 仮想環境の使用

プロジェクトは `venv` 仮想環境を使用しています：

```bash
# 仮想環境内のPythonを使用
source venv/bin/activate
python python/main.py --help

# または仮想環境をアクティベート
source .venv/bin/activate  # Linux/Mac
python3 python/main.py --help
```

### 依存パッケージのインストール

```bash
# 仮想環境内にインストール
.venv/bin/pip install -r requirements.txt

# または仮想環境をアクティベートしてから
source .venv/bin/activate
pip install -r requirements.txt
```

## ソルバー選択

3つのプレートソルバーに対応しています。`--solver` で主ソルバーを、`--fallback-solver` でフォールバックソルバーを指定できます。

### 利用可能なソルバー

| ソルバー | 指定名 | 速度 | 精度 | 要件 |
|---------|--------|------|------|------|
| ASTAP | `astap` | 高速（1-2秒/タイル） | 高（< 20 arcsec/pixel） | ASTAP + 星データベース |
| Astrometry.net Online | `astrometry` | 低速（1-5分/タイル） | 非常に高（超広角対応） | APIキー + インターネット |
| Astrometry.net Local | `astrometry_local` | 中速（5-30秒/タイル） | 非常に高（超広角対応） | solve-field + 星カタログ |

### 使用例

```bash
# ASTAP（デフォルト）
python3 python/main.py --input image.fits --output solved.fits --solver astap

# Astrometry.net Online API
python3 python/main.py --input image.fits --output solved.fits --solver astrometry

# Astrometry.net Local
python3 python/main.py --input image.fits --output solved.fits --solver astrometry_local

# フォールバック付き（ASTAP失敗時にAstrometry.net Onlineで再試行）
python3 python/main.py --input image.fits --output solved.fits \
  --solver astap --fallback-solver astrometry

# 超広角向け（ローカル→オンラインのフォールバック）
python3 python/main.py --input wide.fits --output solved.fits \
  --solver astrometry_local --fallback-solver astrometry
```

### 設定ファイル（config/settings.json）

各ソルバーの設定は `config/settings.json` で管理します。詳細は [Astrometry.net セットアップガイド](docs/ASTROMETRY_NET_SETUP.md) を参照してください。

## 制限事項

- 超広角レンズの歪み補正は未実装（線形WCSのみ）

## 重要な仕様と実装詳細

### XISF形式の完全サポート

このプロジェクトは、PixInsightのネイティブ形式であるXISFを完全にサポートしています。

**実装の特徴:**

1. **RGB形式の保持**:
   - XISF（RGB）画像をRGB形式のまま処理
   - ASTAPがRGB→モノクロ変換を自動処理
   - 出力もRGB形式で保存

2. **メタデータの保持**:
   - FITSキーワードの完全な保持と変換
   - XISFプロパティの維持
   - カメラ情報、撮影パラメータの保持

3. **WCS情報の保存**:
   - FITSキーワード形式でWCS情報を保存
   - PixInsightで完全に読み込み可能
   - PLTSOLVD=T フラグで解決済みを明示

**技術的な詳細:**

XISF形式では、FITSキーワードが以下の形式で保存されます：

```python
{
    'FOCALLEN': [{'value': '249.34034', 'comment': 'Focal length (mm)'}],
    'EXPTIME': [{'value': '300.000', 'comment': 'Exposure time in seconds'}]
}
```

実装では以下の変換を行います：

- **読み込み時**: `_parse_fits_keywords()` が上記形式を単純な辞書に変換
- **保存時**: `_format_fits_keywords_for_xisf()` が単純な辞書を上記形式に変換
- **FITS Header変換**: `convert_to_fits_header()` がAstropy WCS用にFITS Headerを生成

### ASTAPとの統合

**XISF対応の実装:**

ASTAPはXISF形式を直接読み書きできますが、WCS情報は`.ini`ファイルにのみ出力します。

```python
# ASTAP実行後、.iniファイルからWCS情報を読み取る
ini_path = work_path.parent / f"{work_path.stem}.ini"
header = self._read_wcs_from_ini(ini_path)
```

**FOV自動検出の採用:**

初期実装ではFOVヒントを計算して渡していましたが、以下の理由で無効化しました：

- FOVヒント指定時にASTAPが失敗するケースがある
- ASTAPの自動検出が非常に高精度（1.7°程度で正確に解決）
- 計算FOV（4.5°）より小さい検索窓で成功

```python
# FOVヒントは計算するが、ASTAPには渡さない
logger.info(f"estimated tile FOV={tile_fov:.1f}° (not used as hint)")
fov_hint = None  # ASTAPの自動検出を使用
```

### WCS統合アルゴリズムの詳細

**制御点の収集:**

各タイルから10×10のグリッド点を制御点として抽出し、それぞれの天球座標を計算します。

```python
# 各タイル毎に100個の制御点を収集
nx, ny = 10, 10
for ix in range(nx):
    for iy in range(ny):
        pixel_x = x_start + (tile_width / (nx - 1)) * ix
        pixel_y = y_start + (tile_height / (ny - 1)) * iy
        ra, dec = tile_wcs.pixel_to_world_values(local_x, local_y)
```

**重み付け戦略:**

1. **位置による重み**: 画像中心からの距離の逆数
   ```python
   distance_weight = 1.0 / (1.0 + distance_from_center)
   ```

2. **品質による重み**: 解決時間が短い = 高品質
   ```python
   quality_weight = 10.0 / (1.0 + solve_time)
   ```

3. **ピクセルスケール有無**: スケール情報があれば高重み
   ```python
   if pixel_scale: weight *= 2.0
   ```

**最適化:**

scipy.optimize.least_squaresを使用してWCSパラメータを最適化：

```python
result = least_squares(
    residual_function,
    initial_params,
    loss='soft_l1',  # 外れ値に対してロバスト
    f_scale=1.0
)
```

### メタデータ変換の仕組み

プロジェクト内で複数のメタデータ形式を扱います：

1. **XISF形式** (xisfライブラリが返す)
   ```python
   {'KEY': [{'value': '123', 'comment': 'description'}]}
   ```

2. **単純な辞書形式** (Python内部処理用)
   ```python
   {'KEY': 123}
   ```

3. **FITS Header形式** (Astropy WCS用)
   ```python
   header['KEY'] = 123
   ```

変換フロー：

```
XISF File → xisf.XISF.read()
         ↓
    XISF形式のdict
         ↓
    _parse_fits_keywords() → 単純な辞書
         ↓
    convert_to_fits_header() → FITS Header
         ↓
    WCS(header)
```

保存フロー：

```
単純な辞書 → _format_fits_keywords_for_xisf()
         ↓
    XISF形式のdict
         ↓
    xisf.XISF.write() → XISF File
```

## 実装済み機能（2026-02-06現在）

### コア機能
- ✅ **XISF形式の完全サポート** - PixInsightネイティブ形式のRGB画像を完全サポート
- ✅ **FITS形式の完全サポート** - 従来のFITS形式にも対応
- ✅ **自動形式判定** - 入力ファイルの形式を自動判定し、同じ形式で出力
- ✅ **RGB色情報の保持** - RGB画像をRGBのまま処理（モノクロ変換不要）
- ✅ **並列処理** - 複数タイルを並列でプレートソルブ（ThreadPoolExecutor使用）

### ASTAP統合
- ✅ **XISF対応** - ASTAPへのXISFファイル直接渡し
- ✅ **.iniファイルからのWCS読み取り** - XISF用のWCS情報を.iniファイルから取得
- ✅ **FOV自動検出** - ASTAPの高精度な自動FOV検出を活用
- ✅ **エラーハンドリング** - 詳細なエラーメッセージとロギング

### WCS統合
- ✅ **重み付き最小二乗法** - 画像全体からの制御点を使用した最適化
- ✅ **オーバーラップ検証** - タイル間の整合性チェック
- ✅ **タイル位置情報の保存** - 各タイルの元画像での位置をメタデータに記録

### メタデータ処理
- ✅ **XISF FITSキーワード変換** - xisfライブラリ形式 ⇔ 単純な辞書 ⇔ FITS Header
- ✅ **メタデータ保持** - 元画像のメタデータを出力に継承
- ✅ **WCS情報の完全な保存** - CRVAL, CRPIX, CD行列など全てのWCSパラメータ

### ユーティリティ
- ✅ **詳細なログ出力** - ステップごとの進捗とデバッグ情報
- ✅ **一時ファイル管理** - --keep-tempオプションでデバッグ用に保持可能
- ✅ **設定ファイル対応** - JSON形式の設定ファイル

## 既知の問題と制限事項

### 制限事項

1. **ソルバー依存**
   - 各ソルバーは個別のインストールが必要
   - ASTAP: 星データベース必須、Astrometry.net Local: solve-fieldと星カタログ必須

2. **線形WCSのみ**
   - SIP歪み補正は未実装
   - 超広角レンズの歪みには対応していない
   - TAN投影のみサポート

3. **メモリ使用量**
   - 大きな画像（例: 8000x6000以上）では大量のメモリを使用
   - RGB画像は特にメモリ消費が大きい

### 既知のバグ

現在、重大な既知のバグはありません。

### パフォーマンス

**典型的な処理時間（M31画像 4144x2822の例）:**
- 画像読み込み: 0.2秒
- 分割（2x2）: 0.3秒
- ASTAP解決（4タイル並列）: 1.4秒
- WCS統合: 4.7秒
- 出力保存: 0.3秒
- **合計: 約7-9秒**

**最適化の余地:**
- WCS統合の最適化アルゴリズムを改善
- 大きな画像のタイル保存を高速化
- メタデータ変換処理の効率化

## 今後の実装予定

### 優先度: 高
- [ ] **Astrometry.net対応** - より高精度なプレートソルブ
- [ ] **SIP歪み補正** - 広角レンズの歪みに対応
- [ ] **エラーリカバリ** - 一部タイルが失敗しても続行

### 優先度: 中
- [ ] **PixInsight JavaScript統合** - GUI版の提供
- [ ] **完全なテストスイート** - ユニットテストとE2Eテスト
- [ ] **進捗表示の改善** - プログレスバーの追加
- [ ] **設定のバリデーション** - より詳細な入力チェック

### 優先度: 低
- [ ] **GUI版（スタンドアロン）** - Electron/Tauriを使用
- [ ] **バッチ処理** - 複数画像の一括処理
- [ ] **クラウド対応** - S3等からの直接読み込み

## ライセンス

MIT License

## 貢献

プルリクエストやイシューの報告を歓迎します。

## 参考資料

- [ASTAP](https://www.hnsky.org/astap.htm) - 高速プレートソルバー
- [Astropy](https://www.astropy.org/) - 天文学Pythonライブラリ
- [FITS WCS Standard](https://fits.gsfc.nasa.gov/fits_wcs.html) - FITS WCS規格
- [PixInsight](https://pixinsight.com/) - 天体画像処理ソフトウェア
- [XISF Specification](https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html) - XISF形式仕様
