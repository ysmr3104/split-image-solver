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

### 現在のテスト状況（2026-02-05）

**テスト画像:**

- ファイル: `masterLight_BIN-1_4144x2822_EXPOSURE-300.00s_FILTER-HO3_RGB.xisf`
- 対象: M31（アンドロメダ銀河）
- カメラ: ZWO ASI294MC Pro
- 焦点距離: 249.34mm
- ピクセルサイズ: 4.63um
- ピクセルスケール: 3.83 arcsec/pixel
- 中心座標: RA=10.695°, DEC=41.259°

**現在の問題:**

- ASTAPが全てのタイルで "No solution found!" を返す
- 実行コマンド例:

  ```bash
  .venv/bin/python3 python/main.py \
    --input "/Users/yossy/Downloads/masterLight_BIN-1_4144x2822_EXPOSURE-300.00s_FILTER-HO3_RGB.xisf" \
    --output "/Users/yossy/Downloads/test_solved.xisf" \
    --grid 2x2 \
    --overlap 200 \
    --pixel-scale 3.83 \
    --ra 10.695 \
    --dec 41.259 \
    --temp-dir /tmp/solver_test \
    --keep-temp
  ```

**次のデバッグステップ:**

1. 一時ディレクトリ `/tmp/solver_test/split_solver_YYYYMMDD_HHMMSS/splits/` の確認
2. タイルファイル（tile_00_00.fits等）をASTAPで手動実行
3. ASTAPのデータベースパスを確認・設定
4. タイル画像の品質確認（星が十分に検出されているか）
5. RGB画像の場合、緑チャンネルへの変換が正しく行われているか確認

**重要な発見（2026-02-05）:**

1. **XISFファイルの直接使用**: 元のXISF（RGB）ファイルを直接ASTAPに渡すと成功する
   - RGB→モノクロ変換したFITSファイルでは失敗
   - ASTAPはXISF形式を直接サポートしており、RGBからモノクロ変換も自動で行う

2. **FOVとピクセルスケールの警告**:
   - 計算値: FOV=4.4度, pixel_scale=3.83"/pix
   - ASTAP推奨値: **FOV=3.0度, pixel_scale=3.8"/pix**
   - 実際の焦点距離: 249mm（メタデータと一致）

3. **成功したソルブ結果**:

   ```text
   Solution found: RA=0:42:46.87, Dec=+41:15:32.7
   Solved in 0.3 sec
   ```

**修正済み:**

- `main.py`: `--keep-temp`オプション指定時に一時ファイルが自動削除されないように修正（2026-02-05）

### オーバーラップ検証失敗

```
Overlap validation failed: max error = 10.5" (tolerance = 5.0")
```

**原因と解決方法:**
- **広角レンズの歪み**: 許容誤差を増やす (`--overlap-tolerance 15`)
- **ソルブの精度不足**: より多くの星が含まれるようタイルサイズを調整
- **注意**: 検証失敗でも処理は続行されますが、結果の精度が低い可能性があります

### 仮想環境の使用

プロジェクトは `.venv` 仮想環境を使用しています：

```bash
# 仮想環境内のPythonを使用
.venv/bin/python3 python/main.py --help

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

## 制限事項

- ASTAPが必須（他のプレートソルバーは未対応）
- 超広角レンズの歪み補正は未実装（線形WCSのみ）

## 重要な仕様

### XISF形式の画像処理

**問題**: XISF（RGB）画像をFITS（モノクロ）に変換してASTAPに渡すとプレートソルブに失敗する

**解決**: XISF形式の画像はXISF形式のままASTAPに渡す

- ASTAPはXISF形式を直接サポート
- RGB→モノクロ変換もASTAPが自動で処理
- タイル分割時もXISF形式を維持する必要がある

**実装方針**:

1. 入力がXISF形式の場合、タイルもXISF形式で保存
2. FITS形式の場合は既存の処理を維持
3. `image_splitter.py`で形式を保持するよう修正が必要

### FOVとピクセルスケールの計算

**計算式**:

```python
pixel_scale = 206.265 * pixel_size_um / focal_length_mm
fov = (pixel_scale * image_width_pixels) / 3600.0
```

**注意**:

- 計算値とASTAP推奨値が異なる場合がある
- XISFメタデータの焦点距離を使用すること
- ASTAPの警告メッセージを確認し、必要に応じて調整

## 実装済み機能

- ✅ FITS形式の完全サポート
- ✅ XISF形式のネイティブサポート
- ✅ 自動形式判定と変換
- ✅ WCS情報のFITS/XISF両形式への保存
- ✅ 並列処理による高速化
- ✅ オーバーラップ領域での整合性検証

## 今後の実装予定

- [ ] PixInsight JavaScript統合（GUI版）
- [ ] SIP歪み補正（広角レンズ対応）
- [ ] Astrometry.net対応
- [ ] 完全なテストスイート
- [ ] GUI版（スタンドアロン）

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
