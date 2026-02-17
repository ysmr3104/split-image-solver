# Split Image Solver

広角星野写真を分割してプレートソルブし、統合したWCS座標情報を元画像に適用するツールです。

PixInsightの ImageSolver では対応できない超広角な範囲の星空画像に対応します。

## 特徴

- **柔軟な分割**: 2x2, 3x3, 2x4など、任意のグリッドパターンで画像を分割
- **高精度**: SIP歪み補正対応、オーバーラップ領域での整合性検証
- **部分ソルブ対応**: 一部のタイルのソルブに失敗しても、成功したタイルからWCSを全体に適用。星景写真で地上風景が含まれるタイルがソルブできなくても、空の部分だけで座標情報を生成可能
- **並列処理**: 複数の分割画像を並列でプレートソルブし、処理時間を短縮
- **ビュー状態の保持**: PixInsightで編集中（ストレッチ、ABE等適用後）の画像に対してソルブしても、ピクセルデータと処理履歴を維持したままWCSを適用
- **XISF/FITS対応**: PixInsightネイティブのXISF形式とFITS形式の両方に完全対応
- **自動形式判定**: 入力ファイルの形式を自動判定し、同じ形式で出力
- **魚眼レンズ対応**: equisolid/equidistant/stereographic投影に対応し、対角180°超のFOVでもソルブ可能

## 必要な環境

### 必須ソフトウェア

- **Python 3.8以降**
- **Astrometry.net（solve-field）** - ローカルプレートソルバー
  - インストール: `brew install astrometry-net netpbm`（macOS）
  - `netpbm` は `solve-field` が内部で使用する `pnmfile` コマンドを提供します
  - 星カタログ（インデックスファイル）が必要
  - 詳細: [セットアップガイド](docs/ASTROMETRY_NET_SETUP.md)

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
- Astrometry.net（solve-field）
- 十分なディスク容量（星カタログ用に約1-2GB）

**動作確認済み環境:**
- macOS 14.x (Apple Silicon M1/M2)
- Python 3.14
- astrometry-net 0.97（Homebrew）

### 簡単インストール（Makefile使用・推奨）

```bash
# 1. リポジトリをクローン
git clone https://github.com/yourusername/split-image-solver.git
cd split-image-solver

# 2. 開発環境を一括セットアップ
make install-dev

# 3. 設定ファイルを作成して編集
cp config/settings.example.json config/settings.json

# 4. solve-fieldのインストール確認
solve-field --help
```

### Astrometry.netのインストール

詳細は [セットアップガイド](docs/ASTROMETRY_NET_SETUP.md) を参照してください。

**macOSの場合:**

```bash
brew install astrometry-net netpbm
```

**星カタログのダウンロード:**

対象画像の視野角に合ったインデックスファイルが必要です。公式サイト http://data.astrometry.net/ からダウンロードしてください。

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
```

3. Python依存関係をインストール:

```bash
pip install -r requirements.txt
```

4. 設定ファイルを作成:

```bash
cp config/settings.example.json config/settings.json
```

## PixInsight ユーザー向けクイックスタート

PixInsight から Split Image Solver を使うための手順です。上から順に進めてください。

### 1. リポジトリをクローン

```bash
git clone https://github.com/yourusername/split-image-solver.git
cd split-image-solver
```

### 2. Python 環境をセットアップ

```bash
make install-dev
```

これにより `.venv/` 仮想環境が作成され、すべての依存パッケージがインストールされます。

### 3. astrometry-net と netpbm をインストール

```bash
brew install astrometry-net netpbm
```

`netpbm` は `solve-field` が内部で使用するため必須です。インストール後、動作確認:

```bash
solve-field --help
```

### 4. インデックスファイル（星カタログ）をダウンロード

撮影に使用したレンズの焦点距離に応じたインデックスファイルが必要です。

```bash
# astrometry.cfg が参照するディレクトリを確認
cat /opt/homebrew/etc/astrometry.cfg | grep addpath
# 出力例: addpath /opt/homebrew/share/astrometry/data

# そのディレクトリにインデックスファイルをダウンロード
# 35mm レンズ（FOV ~60°）の場合: 4100 シリーズ全体
cd /opt/homebrew/share/astrometry/data
for i in $(seq 4110 4119); do
  curl -O http://data.astrometry.net/4100/index-${i}.fits
done
```

| レンズ焦点距離 | FOV (フルサイズ) | 必要なインデックス |
|--------------|-----------------|------------------|
| 15mm (魚眼) | ~183° | 4107, 4110 ~ 4119, 4208 ~ 4219 |
| 24mm | ~74° | 4110 ~ 4119 |
| 35mm | ~54° | 4110 ~ 4119 |
| 50mm | ~40° | 4112 ~ 4118 |
| 85mm | ~24° | 4115 ~ 4119, 4200 シリーズ |

詳細: [Astrometry.net セットアップガイド](docs/ASTROMETRY_NET_SETUP.md)

### 5. astrometry.cfg の確認

```bash
cat /opt/homebrew/etc/astrometry.cfg
```

`addpath` が指すディレクトリにインデックスファイルがあることを確認:

```bash
ls /opt/homebrew/share/astrometry/data/index-41*.fits
```

ファイルが表示されれば OK です。

### 6. PixInsight にスクリプトを配置

```bash
# macOS の場合
cp javascript/SplitImageSolver.js ~/PixInsight/scripts/
```

PixInsight を再起動し、**Script > Utilities > SplitImageSolver** から実行可能になります。

### 7. PixInsight で初回実行

1. PixInsight で対象画像を開き、ディスクに保存（File > Save As）
2. **Script > Utilities > SplitImageSolver** を実行
3. Settings で Python パスを設定: `.venv/bin/python` のフルパス
4. Script Directory にリポジトリのルートパスを設定
5. **Focal Length**（焦点距離 mm）と **Pixel Pitch**（ピクセルピッチ μm）を入力
6. 魚眼レンズの場合は **Fisheye lens** チェックボックスをON（機材DBに登録済みの魚眼レンズは自動でONになります）
7. Grid を推奨サイズに設定（ダイアログに表示される推奨値を参考に。魚眼レンズでは12x8や10x10が推奨されます）
8. 「Execute」をクリック

詳細なパラメータ説明は [PixInsight スクリプト README](javascript/README.md) を参照してください。

## 使い方

### コマンドライン

基本的な使い方:

```bash
python3 python/main.py \
  --input input_image.fits \
  --output output_image.fits \
  --grid 3x3 \
  --overlap 100
```

#### オプション

**必須:**
- `--input PATH`: 入力FITS/XISF画像パス
- `--output PATH`: 出力FITS/XISF画像パス

**分割設定:**
- `--grid NxM`: 分割グリッドパターン (例: 2x2, 3x3, 2x4) [デフォルト: 2x2]
- `--overlap NUM`: オーバーラップピクセル数 [デフォルト: 100]

**FOV/座標ヒント:**
- `--focal-length MM`: 焦点距離 (mm) - FOV計算に使用
- `--pixel-pitch UM`: ピクセルピッチ (μm) - 機材DBにないカメラの場合に指定
- `--pixel-scale ARCSEC`: ピクセルスケール (arcsec/pixel) - 直接指定する場合
- `--ra DEG`: 視野中心の赤経 (degrees)
- `--dec DEG`: 視野中心の赤緯 (degrees)
- `--lens-type TYPE`: レンズ投影型 (rectilinear, fisheye_equisolid, fisheye_equidistant, fisheye_stereographic) [デフォルト: rectilinear]

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

**例1: 3x3分割で広角画像を処理（推奨）**

```bash
python3 python/main.py \
  --input wide_field_image.xisf \
  --output solved_image.xisf \
  --grid 3x3 \
  --overlap 100
```

**例2: RA/DECヒント付きで処理**

```bash
python3 python/main.py \
  --input wide_field_image.xisf \
  --output solved_image.xisf \
  --grid 3x3 \
  --overlap 100 \
  --pixel-scale 35 \
  --ra 98.0 --dec 5.0
```

**例3: 魚眼レンズ（Sigma 15mm Fisheye + Sony A7R IV）**

```bash
python3 python/main.py \
  --input fisheye_image.xisf \
  --output solved_fisheye.xisf \
  --grid 12x8 \
  --overlap 150 \
  --focal-length 15 \
  --pixel-pitch 3.76 \
  --ra 276.0 --dec -24.0 \
  --lens-type fisheye_equisolid
```

魚眼レンズでは `--lens-type fisheye_equisolid` を指定することで、equisolid（等立体角）投影に基づく正確なFOV計算・スケールヒントが使われます。機材DBに登録済みのレンズは `--lens` 指定で自動検出されます。

**例4: 詳細ログ出力**

```bash
python3 python/main.py \
  --input ultra_wide_image.fits \
  --output solved_ultra_wide.fits \
  --grid 3x3 \
  --overlap 150 \
  --log-level DEBUG \
  --log-file solver.log
```

## アルゴリズム

### 処理フロー

1. **画像分割**: 元画像を指定されたグリッドパターンで分割
   - オーバーラップ領域を含めて分割
   - 各分割画像の位置情報をFITSヘッダーに記録

2. **プレートソルブ**: 各分割画像に対してsolve-fieldを実行
   - 並列処理で高速化
   - SIP歪み補正を含むWCS情報を取得

3. **WCS座標変換**: 分割画像のWCSを元画像座標系に変換
   - CRPIX（参照ピクセル座標）をオフセット調整
   - SIP係数のCRPIXも同期

4. **整合性検証**: オーバーラップ領域でのWCS整合性を確認

5. **WCS統合**: 全分割画像のWCSから最適な元画像WCSを計算
   - 中心タイルベースまたは重み付き最小二乗法

6. **WCS書き込み**: 統合したWCS情報を元画像に書き込み

## プロジェクト構造

```
split-image-solver/
├── config/
│   ├── settings.json              # 設定ファイル
│   └── settings.example.json      # 設定例
├── python/
│   ├── main.py                    # メインスクリプト
│   ├── image_splitter.py          # 画像分割
│   ├── solvers/
│   │   ├── base_solver.py         # ソルバー基底クラス
│   │   ├── astrometry_local_solver.py  # solve-field統合
│   │   └── factory.py             # ソルバーファクトリー
│   ├── wcs_integrator.py          # WCS座標統合
│   ├── fits_handler.py            # FITSヘッダー操作
│   ├── xisf_handler.py            # XISFファイル操作
│   └── utils/
│       ├── logger.py              # ロギング
│       └── coordinate_transform.py # 座標変換
├── tests/                         # テスト
├── docs/                          # ドキュメント
├── requirements.txt               # Python依存関係
└── README.md
```

## トラブルシューティング

### solve-fieldが見つからない

```
FileNotFoundError: solve-field command not found
```

**解決方法:**
- `brew install astrometry-net`（macOS）でインストール
- または `config/settings.json` で `solve_field_path` を明示的に指定

### すべてのタイルのソルブに失敗

**原因と解決方法:**
- **星カタログが不足**: 対象の視野角に合ったインデックスファイルをダウンロード
- **インデックスファイルのパスが合っていない**: `astrometry.cfg` の `addpath` が指すディレクトリにインデックスファイルがあるか確認（下記参照）
- **視野が広すぎる**: 分割数を増やす（3x3推奨）
- **RA/DECヒントを活用**: `--ra` `--dec` `--pixel-scale` を指定して検索範囲を絞る

### インデックスファイルのパスが合わない

`solve-field` がインデックスファイルを見つけられない場合:

```bash
# 1. astrometry.cfg の場所と addpath を確認
cat /opt/homebrew/etc/astrometry.cfg | grep addpath

# 2. そのディレクトリにインデックスファイルがあるか確認
ls /opt/homebrew/share/astrometry/data/index-*.fits

# 3. ファイルがなければダウンロード、または addpath を修正
```

Homebrew のバージョンアップ等で `addpath` のディレクトリが変わる場合があります。インデックスファイルの実体がある場所を `addpath` に設定してください。

### オーバーラップ検証失敗

```
Overlap validation failed: max error = 10.5" (tolerance = 5.0")
```

**解決方法:**
- 許容誤差を増やす (`--overlap-tolerance 15`)
- より多くの星が含まれるようタイルサイズを調整

## 制限事項

- 超広角レンズの歪みが大きい場合、WCS精度が低下する可能性がある
- 大きな画像（8000x6000以上）では大量のメモリを使用

### 低解像度・超広角カメラ（ATOM Cam 2 等）について

ATOM Cam 2 のような監視カメラ系デバイス（1920×1080, 対角120° FOV, ピクセルスケール~191"/px）は、魚眼投影対応後もプレートソルブが困難です。

**インデックスファイルの問題**: この解像度では astrometry.net の 4200-4207 シリーズ（超広角用）が必要ですが、これらは healpix 分割で配布されており全天カバーに数十GBのダウンロードが必要です。また、より小スケールの 4100-4106 シリーズは公式サーバー（`data.astrometry.net/4100/`）に存在しません。

**解像度の問題**: ~191"/px では1ピクセルが約3角分に相当し、solve-field が星のパターンマッチングに使える星の数が極めて限られます。タイル分割するとさらに1タイルあたりの星数が減少し、信頼性の高いソルブが困難になります。

対象天域の healpix タイルのみをダウンロードすれば原理的には可能ですが、実用的なワークフローとしては現時点で未検証です。

## ライセンス

MIT License

## 参考資料

- [Astrometry.net](https://astrometry.net/) - プレートソルバー
- [Astropy](https://www.astropy.org/) - 天文学Pythonライブラリ
- [FITS WCS Standard](https://fits.gsfc.nasa.gov/fits_wcs.html) - FITS WCS規格
- [PixInsight](https://pixinsight.com/) - 天体画像処理ソフトウェア
- [XISF Specification](https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html) - XISF形式仕様
