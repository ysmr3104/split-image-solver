# Split Image Solver - PixInsight Script

PixInsight 用の自動プレートソルブスクリプトです。
astrometry.net API またはローカル solve-field を使用して画像をソルブし、WCS 情報を適用します。
広角画像のタイル分割ソルブにも対応しています。

## ソルブモード

- **API モード**（デフォルト）: astrometry.net API でソルブ。Python 不要、API キーのみで利用可能
- **Local モード**: ローカル solve-field でソルブ。Python + solve-field のセットアップが必要

## 必要な環境

- **PixInsight 1.8.9 以降**
- **astrometry.net API キー**（無料、API モード用）: https://nova.astrometry.net/

Local モードを利用する場合は、追加で Python 3.8+ / solve-field / 星カタログが必要です。
詳細は[プロジェクトの README](../README.md#local-モードのセットアップ) を参照してください。

## ファイル構成

| ファイル | 説明 |
|---------|------|
| `SplitImageSolver.js` | メインスクリプト（UI + ソルブエンジン） |
| `astrometry_api.js` | astrometry.net API クライアント |
| `wcs_math.js` | WCS 数学ライブラリ（TAN 投影、SIP フィット等） |
| `wcs_keywords.js` | FITS キーワードユーティリティ |
| `equipment_data.jsh` | 機材データベース（カメラ・レンズ） |

全ファイルが同一ディレクトリに配置されている必要があります。
`SplitImageSolver.js` が `#include` で他のファイルを読み込みます。

## スクリーンショット

### メインダイアログ

![メインダイアログ](../docs/images/main-dialog.jpg)

機材選択でピクセルスケールと推奨グリッドを自動計算。FITS ヘッダーからカメラ・レンズを自動認識し、型番も表示されます。

### Settings ダイアログ

![Settings ダイアログ](../docs/images/settings-dialog.jpg)

ソルブモード（API / Local）の切り替え、API キー、Python 環境の設定を行います。

## インストール

### PixInsight リポジトリ経由（推奨）

1. **Resources > Updates > Manage Repositories**
2. リポジトリ URL を追加:
   ```
   https://ysmrastro.github.io/pixinsight-scripts/
   ```
3. **Check for Updates** → SplitImageSolver をインストール

### 手動インストール

上記5ファイルを PixInsight のスクリプトディレクトリにコピー:

```
{PixInsight}/src/scripts/SplitImageSolver/
├── SplitImageSolver.js
├── astrometry_api.js
├── wcs_math.js
├── wcs_keywords.js
└── equipment_data.jsh
```

スクリプトディレクトリの場所:
- macOS: `/Applications/PixInsight/src/scripts/SplitImageSolver/`
- Windows: `C:\Program Files\PixInsight\src\scripts\SplitImageSolver\`
- Linux: `/opt/PixInsight/src/scripts/SplitImageSolver/`

PixInsight を再起動後、**Script > Astrometry > SplitImageSolver** から実行可能。

## 使い方

### 初期設定

1. **Script > Astrometry > SplitImageSolver** を実行
2. 左下の **Settings...** ボタンをクリック
3. **Solve Mode** を選択:
   - **API (astrometry.net)**: API キーを入力（デフォルト）
   - **Local (solve-field)**: Python パスとスクリプトディレクトリを設定
4. 「OK」で保存

設定は永続化されるため、次回以降は自動的に前回のモードで起動します。

### 基本（単一画像ソルブ）

1. PixInsight で対象画像を開く
2. **Script > Astrometry > SplitImageSolver** を実行
3. 「**Solve**」をクリック

### 高速ソルブ（ヒント付き）

RA/DEC やピクセルスケールのヒントを与えると、ソルブ速度が大幅に向上します。

1. **カメラ/レンズ** を選択 → ピクセルスケールが自動計算される
2. **Object** に天体名（例: "M31", "Orion Nebula"）を入力し「**Search**」→ RA/DEC が自動入力される
3. 「**Solve**」をクリック

### 広角画像の分割ソルブ

1. カメラ/レンズを選択すると推奨グリッドが表示される
2. **Grid** を推奨サイズに設定（例: 3x3）
3. **Overlap** を設定（デフォルト 100px）
4. 「**Solve**」をクリック

処理の流れ:
- Pass 1: 全タイルをソルブ
- Pass 2: 失敗タイルを成功タイルのヒントで自動再試行
- オーバーラップ検証 → 異常タイルを除外
- 全成功タイルの WCS を統合して元画像に適用

## パラメータ詳細

### 機材設定

| パラメータ | 説明 |
|-----------|------|
| Camera | カメラ機種。FITS ヘッダーの INSTRUME から自動認識。前回の選択も記憶される |
| Lens | レンズ/鏡筒。FITS ヘッダーの FOCALLEN から近似マッチ。前回の選択も記憶される |

### ソルブ設定

| パラメータ | 説明 | デフォルト | モード |
|-----------|------|-----------|--------|
| Scale | ピクセルスケール (arcsec/px)。カメラ/レンズ選択時は自動計算 | — | 共通 |
| Scale Error | スケール推定の誤差範囲 (%) | 30 | API |
| Object | 天体名。Search ボタンで Sesame 検索 → RA/DEC 自動入力 | — | 共通 |
| RA | 画像中心の赤経 (HMS or degrees) | — | 共通 |
| DEC | 画像中心の赤緯 (DMS or degrees) | — | 共通 |
| Radius | 座標検索半径 (°) | 10 | API |

### 分割設定

| パラメータ | 説明 | デフォルト | モード |
|-----------|------|-----------|--------|
| Grid | 分割グリッド。1x1 = 単一画像モード | 1x1 | 共通 |
| Overlap | タイル間オーバーラップ (px) | 100 | 共通 |
| Downsample | ダウンサンプル設定（分割モードでは自動） | Auto | API |
| SIP Order | SIP 歪み補正の多項式次数 | 4 | API |
| Timeout | タイルあたりのタイムアウト (分) | 1 | API |

「API」と記載の項目は Local モード時にグレーアウトされます（Python 側が自動処理）。

### グリッドサイズの目安

| 対角 FOV | 推奨グリッド | 例 |
|---------|------------|-----|
| ～10° | 1x1 | 望遠鏡 |
| ～30° | 2x2 | 200mm レンズ |
| ～60° | 3x3 | 35-50mm レンズ |
| ～90° | 4x4 | 24mm レンズ |
| ～120° | 6x4 | 14-20mm レンズ |
| 120°～ | 8x6 以上 | 魚眼レンズ |

## トラブルシューティング

### API ログイン失敗

- API キーが正しいか確認: https://nova.astrometry.net/api_help
- インターネット接続を確認
- PixInsight の Process Console にエラー詳細が表示される

### ソルブに時間がかかる

- RA/DEC ヒントと Scale を入力するとソルブ速度が劇的に向上する
- 天体名を入力して Search ボタンで座標を取得するのが最も簡単

### ソルブ失敗

- ピクセルスケールが大幅に間違っていないか確認
- Scale Error を大きくする（30 → 50）
- 分割モードの場合、タイルが小さすぎると星が少なくてソルブ失敗しやすい

### 一部タイルがソルブできない

- 地上風景や雲を含むタイルはソルブできない（正常動作）
- 2タイル以上成功すれば WCS 統合が可能
- Pass 2 で自動的にリトライされる

### Local モードが動作しない

- Settings で Python パスとスクリプトディレクトリが正しいか確認
- .venv 内の Python は Finder から見えない場合があるため、パスを直接入力
- solve-field がインストールされ、PATH に含まれているか確認
- Process Console のログで Python のエラーメッセージを確認

## 技術仕様

- **PJSR 互換**: PixInsight 1.8.9 以降（ES5 JavaScript）
- **HTTP 通信**: ExternalProcess + curl（一時ファイル経由）
- **API**: astrometry.net REST API（login → upload → poll → calibration → WCS）
- **Local**: ExternalProcess + Python（/bin/sh -c 経由、Homebrew PATH 自動追加）
- **WCS フィット**: WCSFitter（CD 行列 + SIP 歪み補正）、制御点直接設定（SplineWorldTransformation）
- **設定永続化**: PixInsight Settings API（ソルブモード、API キー、Python パス、カメラ/レンズ選択等）
