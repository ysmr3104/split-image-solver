# Split Image Solver

[English version](README.md)

広角星野写真を分割してプレートソルブし、統合したWCS座標情報を元画像に適用する PixInsight スクリプトです。

PixInsight の ImageSolver では対応できない超広角な範囲の星空画像に対応します。

> **Note**: 超広角（魚眼等）の場合、画像周辺部の WCS 精度が低下することがあります。より高精度な WCS が必要な場合は、手動で星を指定してフィッティングする [Manual Image Solver](https://github.com/ysmr3104/manual-image-solver) の利用もご検討ください。

## 特徴

- **2つのソルブモード**: astrometry.net API（デフォルト）またはローカル solve-field を選択可能
- **画像プレビュー+グリッドオーバーレイ**: タイル分割の様子をリアルタイムで可視化、STF ストレッチ（None/Linked/Unlinked）対応
- **柔軟な分割**: 1x1（単一画像）から 12x8 まで、FOV に基づく「Recommended」ボタンでワンクリック最適グリッド設定
- **高精度**: SIP 歪み補正対応、WCSFitter による制御点フィット
- **部分ソルブ対応**: 一部のタイルのソルブに失敗しても、成功したタイルから WCS を全体に適用
- **2パスリトライ**: 失敗タイルを隣接成功タイルの WCS ヒントで自動再試行
- **オーバーラップ検証**: 隣接タイルの重複領域で WCS 整合性を自動チェック
- **機材 DB**: カメラ/レンズの自動認識（型番表示対応）、焦点距離・ピクセルピッチ自動入力
- **魚眼レンズ対応**: equisolid/equidistant/stereographic 投影に対応、タイルごとのスケール補正
- **Sesame 天体名検索**: 天体名から RA/DEC を自動入力

## ソルブモード

| モード | 説明 | 必要な環境 |
|--------|------|-----------|
| **API** (デフォルト) | astrometry.net API でソルブ | API キーのみ（Python 不要） |
| **Local** | ローカル solve-field でソルブ | Python + solve-field + 星カタログ |

API モードは追加インストール不要ですぐに利用できます。
Local モードを利用する場合は [docs/setup.md](docs/setup.md) を参照してください。

## 必要な環境

- **PixInsight 1.8.9 以降**
- **astrometry.net API キー**（無料、API モード用）: https://nova.astrometry.net/ でアカウント作成後取得

## インストール

### 方法1: PixInsight リポジトリ（推奨）

1. PixInsight を開く
2. **Resources > Updates > Manage Repositories** を開く
3. リポジトリ URL を追加:
   ```
   https://ysmrastro.github.io/pixinsight-scripts/
   ```
4. **Resources > Updates > Check for Updates** を実行
5. SplitImageSolver をインストール

### 方法2: 手動インストール

1. リポジトリをクローンまたはダウンロード:
   ```bash
   git clone https://github.com/ysmr3104/split-image-solver.git
   ```

2. `javascript/` 内の以下のファイルを PixInsight スクリプトディレクトリにコピー:
   ```
   SplitImageSolver.js
   astrometry_api.js
   wcs_math.js
   wcs_keywords.js
   equipment_data.jsh
   ```

   スクリプトディレクトリの場所:
   - macOS: `/Applications/PixInsight/src/scripts/SplitImageSolver/`
   - Windows: `C:\Program Files\PixInsight\src\scripts\SplitImageSolver\`
   - Linux: `/opt/PixInsight/src/scripts/SplitImageSolver/`

3. PixInsight を再起動
4. **Script > Astrometry > SplitImageSolver** から実行可能

## スクリーンショット

### メインダイアログ

![メインダイアログ](docs/images/main-dialog.jpg)

左パネルに画像プレビューとグリッドオーバーレイがリアルタイム表示され、タイル分割の様子を確認できます。プレビュー下部の STF ボタンでストレッチモード（None/Linked/Unlinked）を切り替え可能。右パネルには機材選択（FITS ヘッダーから自動認識）、「Recommended」ボタンで FOV に基づく最適グリッドをワンクリック設定、Sesame 天体名検索などのパラメータが並びます。

### Settings ダイアログ

![Settings ダイアログ](docs/images/settings-dialog.jpg)

左下の「Settings...」ボタンから開きます。ソルブモード（API / Local）の切り替え、API キー、Python 環境の設定を行います。どちらのモードの設定値も常に記憶されます。

## 使い方

### クイックスタート（単一画像ソルブ）

1. PixInsight で対象画像を開く
2. **Script > Astrometry > SplitImageSolver** を実行
3. 左下の **Settings...** ボタンで API キーを入力（初回のみ、以降は自動保存）
4. 左パネルのプレビューで画像を確認
5. Grid を **1x1 (Single)** のまま「Solve」をクリック
6. 完了後、画像に WCS が適用される

### 分割ソルブ（広角画像）

1. PixInsight で対象画像を開く
2. **Script > Astrometry > SplitImageSolver** を実行
3. **カメラ/レンズ** を選択（FITS ヘッダーから自動認識される場合あり）
   - 焦点距離・ピクセルピッチが自動入力される
4. **Recommended** ボタンをクリックして FOV に基づく最適グリッドを設定
   - プレビューがリアルタイムで更新され、タイル分割の様子を確認できる
5. 必要に応じて **天体名** を入力し「Search」で RA/DEC を取得
6. 「Solve」をクリック

### パラメータ

| パラメータ | 説明 | デフォルト | モード |
|-----------|------|-----------|--------|
| Camera | カメラ機種（ピクセルピッチ自動入力） | 自動認識 | 共通 |
| Lens | レンズ/鏡筒（焦点距離自動入力） | 自動認識 | 共通 |
| Focal length | 焦点距離 (mm)。カメラ/レンズ未選択時は手入力 | 自動入力 | 共通 |
| Pixel pitch | ピクセルピッチ (μm)。カメラ未選択時は手入力 | 自動入力 | 共通 |
| Scale Error | スケール誤差 (%) | 30 | API |
| Object | 天体名（Sesame 検索） | — | 共通 |
| RA / DEC | 画像中心座標 | — | 共通 |
| Radius | 検索半径 (°) | 10 | API |
| Grid | 分割グリッド (ColsxRows) | 1x1 | 共通 |
| Overlap | タイル間オーバーラップ (px) | 100 | 共通 |
| Downsample | ダウンサンプル設定 | Auto | API |
| SIP Order | SIP 歪み補正の次数 | 4 | API |
| Timeout | タイルあたりのタイムアウト (分) | 1 | API |

「API」と記載の項目は Local モード時にグレーアウトされます（Python 側が自動処理）。

## 技術詳細

プロジェクト構成、処理パイプライン、コーディング規約については [docs/architecture.md](docs/architecture.md) を参照してください。

## トラブルシューティング

### API ログインに失敗

- API キーが正しいか確認: https://nova.astrometry.net/api_help
- インターネット接続を確認

### ソルブに時間がかかる / 失敗する

- **RA/DEC ヒントを入力**: 天体名を入力して Search ボタンで座標を取得すると、ソルブ速度が大幅に向上
- **焦点距離・ピクセルピッチを入力**: カメラ/レンズを選択するか、手動で入力
- **グリッドを調整**: タイルが小さすぎると星が少なくてソルブ失敗しやすい

### 一部タイルがソルブできない

- 地上風景や雲を含むタイルはソルブできません（正常動作）
- 2タイル以上成功すれば WCS 統合が可能です
- Pass 2 リトライで自動的に再試行されます

### WCS 精度が低い

- オーバーラップを増やす（100 → 200px）
- SIP Order を上げる（2 → 4）
- グリッドを細かくする

### Local モードで Python が見つからない

- Settings の Python パスが正しいか確認
- .venv を使用している場合、`/path/to/.venv/bin/python3` を直接入力
- solve-field がインストールされ、PATH に含まれているか確認

## ライセンス

MIT License

## 参考資料

- [Astrometry.net](https://astrometry.net/) — プレートソルバー
- [Astrometry.net API](https://nova.astrometry.net/api_help) — API ドキュメント
- [PixInsight](https://pixinsight.com/) — 天体画像処理ソフトウェア
- [FITS WCS Standard](https://fits.gsfc.nasa.gov/fits_wcs.html) — FITS WCS 規格
