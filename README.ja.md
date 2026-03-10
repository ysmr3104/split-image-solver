# Split Image Solver

[English version](README.md)

広角星野写真を分割してプレートソルブし、統合したWCS座標情報を元画像に適用する PixInsight スクリプトです。

PixInsight の ImageSolver では対応できない超広角な範囲の星空画像に対応します。

> **重要**: Split ソルブでは画像中心から離れるほど歪みが大きくなるため、画像全体にわたって完全に正確な自動ソルブは困難です。周辺部の精度が必要な場合（例: AnnotateImage での利用）は、手動で星を指定してフィッティングする [Manual Image Solver](https://github.com/ysmr3104/manual-image-solver) の利用をご検討ください。Split Image Solver は AnnotateImage の完璧な精度を求めるものではなく、ImageSolver 単体では不可能な超広角画像での SPCC 実行を可能にするツールとお考えください。

## 特徴

- **3つのソルブモード**: astrometry.net API（デフォルト）、ローカル solve-field（Python）、ImageSolver（PixInsight 内蔵）
- **画像プレビュー+グリッドオーバーレイ**: タイル分割の様子をリアルタイムで可視化、STF ストレッチ（None/Linked/Unlinked）対応
- **柔軟な分割**: 1x1（単一画像）から 12x8 まで、FOV に基づく「Recommended」ボタンでワンクリック最適グリッド設定
- **エッジスキップ**: 上下左右のタイル行/列をスキップ（星景写真で地上部分を除外するのに便利）
- **高精度**: SIP 歪み補正対応、WCSFitter による制御点フィット
- **部分ソルブ対応**: 一部のタイルのソルブに失敗しても、成功したタイルから WCS を全体に適用
- **2パスリトライ**: 失敗タイルを隣接成功タイルの WCS ヒントで自動再試行
- **オーバーラップ検証**: 隣接タイルの重複領域で WCS 整合性を自動チェック
- **機材 DB**: カメラ/レンズの自動認識（型番表示対応）、焦点距離・ピクセルピッチ自動入力
- **魚眼レンズ対応**: equisolid/equidistant/stereographic 投影に対応、タイルごとのスケール補正
- **Sesame 天体名検索**: 天体名から RA/DEC を自動入力
- **SPFC 互換**: PCL:AstrometricSolution プロパティ書き込みにより SubframeSelector、SPCC 等と連携

## ソルブモード

| モード | 説明 | 必要な環境 | 精度 | Split |
|--------|------|-----------|------|-------|
| **API** (デフォルト) | astrometry.net API でソルブ | API キーのみ（Python 不要） | 良好 | 対応 |
| **Local** | ローカル solve-field でソルブ | Python + solve-field + 星カタログ | 最高 | 対応 |
| **ImageSolver** | PixInsight 内蔵 ImageSolver でソルブ | 追加環境不要 | — | Single のみ |

精度の順: **Local > API > ImageSolver**。Local モードはローカルにインストールされた solve-field と星カタログを使用するため、最も高精度な結果を得られます。API モードはタイルを astrometry.net サーバーに送信します。ImageSolver（内蔵）は Single（1x1）モードに限定されます。分割された広角タイルを個別にソルブすることが難しいためです。

**ImageSolver モード**は単一画像のプレートソルブに非常に便利です。API キーも Python も不要で、PixInsight だけで完結します。最も手軽に使い始められるモードです。ぜひご活用ください。

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
   imagesolver_bridge.jsh
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

左パネルに画像プレビューとグリッドオーバーレイがリアルタイム表示され、タイル分割の様子を確認できます。スキップされるエッジタイルは暗いオーバーレイと「skip」ラベルで表示されます。プレビュー下部の STF ボタンでストレッチモード（None/Linked/Unlinked）を切り替え可能。右パネルには機材選択（FITS ヘッダーから自動認識）、「Recommended」ボタンで FOV に基づく最適グリッドをワンクリック設定、エッジスキップ（T/B/L/R）で地上部分を除外、Sesame 天体名検索などのパラメータが並びます。

### Settings ダイアログ

![Settings ダイアログ](docs/images/settings-dialog.jpg)

左下の「Settings...」ボタンから開きます。ソルブモード（API / Local / ImageSolver）の切り替え、API キー、Python 環境の設定を行います。すべてのモードの設定値が常に記憶されます。

## 使い方

### クイックスタート（単一画像ソルブ）

1. PixInsight で対象画像を開く
2. **Script > Astrometry > SplitImageSolver** を実行
3. 左下の **Settings...** ボタンで設定:
   - **API モード**: API キーを入力（初回のみ、以降は自動保存）
   - **ImageSolver モード**: 設定不要
   - **Local モード**: Python パスとスクリプトディレクトリを設定
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
5. 星景写真の場合、**Skip edges** で地上部分をスキップ（例: B:2 で下2行をスキップ）
6. 必要に応じて **天体名** を入力し「Search」で RA/DEC を取得
7. 「Solve」をクリック

> **Note**: ImageSolver（内蔵）モードは Single（1x1）グリッドのみ対応です。Split ソルブには API または Local モードをお使いください。

### パラメータ

| パラメータ | 説明 | デフォルト | モード |
|-----------|------|-----------|--------|
| Camera | カメラ機種（ピクセルピッチ自動入力） | 自動認識 | 全モード |
| Lens | レンズ/鏡筒（焦点距離自動入力） | 自動認識 | 全モード |
| Focal length | 焦点距離 (mm)。カメラ/レンズ未選択時は手入力 | 自動入力 | 全モード |
| Pixel pitch | ピクセルピッチ (μm)。カメラ未選択時は手入力 | 自動入力 | 全モード |
| Drizzle | ドリズル統合の倍率 | None (1x) | 全モード |
| Scale Error | スケール誤差 (%) | 30 | API |
| Object | 天体名（Sesame 検索） | — | 全モード |
| RA / DEC | 画像中心座標 | — | 全モード |
| Radius | 検索半径 (°) | 10 | API |
| Grid | 分割グリッド (ColsxRows) | 1x1 | API/Local |
| Overlap | タイル間オーバーラップ (px) | 100 | API/Local |
| Skip edges | 上下左右のスキップするタイル行/列数 (T/B/L/R) | 0 | API/Local |
| Downsample | ダウンサンプル設定 | Auto | API |
| SIP Order | SIP 歪み補正の次数 | 4 | API |
| Timeout | タイルあたりのタイムアウト (分) | 1 | API |

各モードに該当しないパラメータは自動的にグレーアウトされます。

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
- **Skip edges** を使って地上部分を除外すると、処理時間を短縮できます
- 2タイル以上成功すれば WCS 統合が可能です
- Pass 2 リトライで自動的に再試行されます

### WCS 精度が低い

- オーバーラップを増やす（100 → 200px）
- SIP Order を上げる（2 → 4）
- グリッドを細かくする
- 周辺部の精度が必要な場合は [Manual Image Solver](https://github.com/ysmr3104/manual-image-solver) をご検討ください

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
- [Manual Image Solver](https://github.com/ysmr3104/manual-image-solver) — PixInsight 用手動プレートソルバー
