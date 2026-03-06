# Split Image Solver

広角星野写真を分割してプレートソルブし、統合したWCS座標情報を元画像に適用する PixInsight スクリプトです。

PixInsight の ImageSolver では対応できない超広角な範囲の星空画像に対応します。
**Python 不要** — PixInsight の PJSR ネイティブ実装で、astrometry.net API を使用します。

## 特徴

- **Python 不要**: 純粋 PJSR（JavaScript）のみで動作、外部プロセス依存なし
- **astrometry.net API**: ローカルの solve-field インストール不要、API キーのみで利用可能
- **柔軟な分割**: 1x1（単一画像）から 12x8 まで、任意のグリッドパターンで画像を分割
- **高精度**: SIP 歪み補正対応、WCSFitter による制御点フィット
- **部分ソルブ対応**: 一部のタイルのソルブに失敗しても、成功したタイルから WCS を全体に適用
- **2パスリトライ**: 失敗タイルを隣接成功タイルの WCS ヒントで自動再試行
- **オーバーラップ検証**: 隣接タイルの重複領域で WCS 整合性を自動チェック
- **機材 DB**: カメラ/レンズの自動認識、ピクセルスケール自動計算、推奨グリッド提案
- **魚眼レンズ対応**: equisolid/equidistant/stereographic 投影に対応、タイルごとのスケール補正
- **Sesame 天体名検索**: 天体名から RA/DEC を自動入力

## 必要な環境

- **PixInsight 1.8.9 以降**
- **astrometry.net API キー**（無料）: https://nova.astrometry.net/ でアカウント作成後、API キーを取得

Python、solve-field、星カタログのローカルインストールは**不要**です。

## インストール

### 方法1: PixInsight リポジトリ（推奨）

1. PixInsight を開く
2. **Resources > Updates > Manage Repositories** を開く
3. リポジトリ URL を追加:
   ```
   https://raw.githubusercontent.com/ysmr3104/split-image-solver/main/repository/
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
   equipment.json
   ```

   スクリプトディレクトリの場所:
   - macOS: `/Applications/PixInsight/src/scripts/SplitImageSolver/`
   - Windows: `C:\Program Files\PixInsight\src\scripts\SplitImageSolver\`
   - Linux: `/opt/PixInsight/src/scripts/SplitImageSolver/`

3. PixInsight を再起動
4. **Script > Utilities > SplitImageSolver** から実行可能

## 使い方

### クイックスタート（単一画像ソルブ）

1. PixInsight で対象画像を開く
2. **Script > Utilities > SplitImageSolver** を実行
3. API キーを入力（初回のみ、以降は自動保存）
4. Grid を **1x1** のまま「Solve」をクリック
5. 完了後、画像に WCS が適用される

### 分割ソルブ（広角画像）

1. PixInsight で対象画像を開く
2. **Script > Utilities > SplitImageSolver** を実行
3. **カメラ/レンズ** を選択（FITS ヘッダーから自動認識される場合あり）
   - ピクセルスケールと推奨グリッドが自動計算される
4. 必要に応じて **天体名** を入力し「Search」で RA/DEC を取得
5. Grid を推奨サイズに設定
6. 「Solve」をクリック

### パラメータ

| パラメータ | 説明 | デフォルト |
|-----------|------|-----------|
| API Key | astrometry.net の API キー | （必須） |
| Camera | カメラ機種（ピクセルピッチ自動入力） | 自動認識 |
| Lens | レンズ/鏡筒（焦点距離・投影型自動入力） | 自動認識 |
| Scale | ピクセルスケール (arcsec/px) | 自動計算 |
| Scale Error | スケール誤差 (%) | 30 |
| Object | 天体名（Sesame 検索） | （任意） |
| RA / DEC | 画像中心座標 | （任意） |
| Radius | 検索半径 (°) | 15 |
| Grid | 分割グリッド (ColsxRows) | 1x1 |
| Overlap | タイル間オーバーラップ (px) | 200 |
| SIP Order | SIP 歪み補正の次数 | 2 |

## 処理フロー

### 単一画像モード（1x1）

1. 画像を FITS に書き出し → API にアップロード
2. astrometry.net でプレートソルブ
3. WCS FITS ファイルをダウンロード → WCS パラメータを解析
4. WCSFitter で CD 行列 + SIP フィット
5. FITS キーワード + 制御点を画像に適用

### 分割モード（NxM）

1. 画像をオーバーラップ付き NxM タイルに分割
2. 各タイルをダウンサンプル（長辺 2000px 以下）して API にアップロード
3. **Pass 1**: 全タイルをソルブ
4. **Pass 2**: 失敗タイルを成功タイルの WCS ヒントで再試行
5. **オーバーラップ検証**: 隣接タイルの WCS 整合性チェック、異常タイルを除外
6. 全成功タイルの WCS から制御点を収集 → WCSFitter で統合 WCS を生成
7. 統合 WCS を元画像に適用

## プロジェクト構造

```
split-image-solver/
├── javascript/
│   ├── SplitImageSolver.js    # メインスクリプト（UI + エンジン）
│   ├── astrometry_api.js      # astrometry.net API クライアント
│   ├── wcs_math.js            # WCS 数学ライブラリ
│   ├── wcs_keywords.js        # FITS キーワードユーティリティ
│   └── equipment.json         # 機材データベース
├── build-split-release.sh     # リリースビルドスクリプト
├── repository/                # PixInsight リポジトリ配布パッケージ
├── python/                    # レガシー Python 実装（非推奨）
├── tests/                     # テスト
└── docs/                      # ドキュメント
```

## トラブルシューティング

### API ログインに失敗

- API キーが正しいか確認: https://nova.astrometry.net/api_help
- インターネット接続を確認

### ソルブに時間がかかる / 失敗する

- **RA/DEC ヒントを入力**: 天体名を入力して Search ボタンで座標を取得すると、ソルブ速度が大幅に向上
- **ピクセルスケールを入力**: カメラ/レンズを選択するか、手動で入力
- **グリッドを調整**: タイルが小さすぎると星が少なくてソルブ失敗しやすい

### 一部タイルがソルブできない

- 地上風景や雲を含むタイルはソルブできません（正常動作）
- 2タイル以上成功すれば WCS 統合が可能です
- Pass 2 リトライで自動的に再試行されます

### WCS 精度が低い

- オーバーラップを増やす（200 → 400px）
- SIP Order を上げる（2 → 3）
- グリッドを細かくする

## レガシー Python 版について

`python/` ディレクトリにはローカル solve-field を使用する旧 Python 実装が含まれています。
PJSR ネイティブ版（`javascript/`）への移行を推奨します。Python 版は以下の制約があります:

- Python 3.8+ / astropy / scipy / numpy のインストールが必要
- ローカル solve-field + 星カタログ（数 GB）のインストールが必要
- Windows 非対応

## ライセンス

MIT License

## 参考資料

- [Astrometry.net](https://astrometry.net/) — プレートソルバー
- [Astrometry.net API](https://nova.astrometry.net/api_help) — API ドキュメント
- [PixInsight](https://pixinsight.com/) — 天体画像処理ソフトウェア
- [FITS WCS Standard](https://fits.gsfc.nasa.gov/fits_wcs.html) — FITS WCS 規格
