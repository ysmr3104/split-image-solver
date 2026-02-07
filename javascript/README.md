# Split Image Solver - PixInsight Script

PixInsightから Split Image Solver を実行するためのJavaScriptスクリプトです。
広角星空画像を分割プレートソルブし、統合したWCS情報を元画像に書き込みます。

## 前提条件

### Python環境

以下がインストール済みであること:

- Python 3.9以降
- 必要パッケージ: `astropy`, `numpy`, `xisf`, `requests`
- astrometry.net の `solve-field` がローカルにインストール済み

```bash
cd /path/to/split-image-solver
pip install -r requirements.txt
```

### astrometry.net

ローカルの `solve-field` コマンドが利用可能であること。
macOSの場合:

```bash
brew install astrometry-net
```

インデックスファイル（4100シリーズ等）もダウンロードしておくこと。

## インストール

### 方法1: Script > Execute Script File

1. PixInsightを開く
2. メニュー: **Script > Execute Script File...**
3. `javascript/SplitImageSolver.js` を選択して実行

### 方法2: スクリプトディレクトリに配置（推奨）

1. `SplitImageSolver.js` を PixInsight のスクリプトディレクトリにコピー:
   - macOS: `~/PixInsight/scripts/` または `/Applications/PixInsight/scripts/`
   - Windows: `C:\Program Files\PixInsight\scripts\`
   - Linux: `/opt/PixInsight/scripts/`
2. PixInsightを再起動
3. メニュー: **Script > Utilities > SplitImageSolver** から実行可能

## 初回設定

初めて実行すると、環境設定ダイアログが表示されます。

### Python実行ファイル

Pythonの実行パスを指定してください:

| 環境 | 例 |
|------|------|
| venv使用時 | `/path/to/split-image-solver/.venv/bin/python` |
| システムPython (macOS) | `/usr/local/bin/python3` |
| Homebrew Python | `/opt/homebrew/bin/python3` |
| Windows | `C:\Python311\python.exe` |

### スクリプトディレクトリ

`split-image-solver` リポジトリのルートディレクトリを指定してください:

```
/path/to/split-image-solver
```

この設定はPixInsightの再起動後も保持されます。

## 使い方

1. PixInsightで対象画像（XISF/FITS）を開く
2. 画像がディスクに保存されていることを確認（File > Save As）
3. スクリプトを実行
4. パラメータダイアログで設定を確認:
   - **Grid**: 分割数（2x2, 3x3, 4x4）
   - **Overlap**: タイル間のオーバーラップピクセル数
   - **RA/DEC**: FITSヘッダーから自動取得（手動入力も可能）
   - **Pixel scale**: 焦点距離・ピクセルサイズから自動計算
5. 「Execute」をクリック
6. Process Consoleにsolve-fieldのログがリアルタイム表示される
7. 完了後、画像がWCS情報付きで再読み込みされる

## パラメータガイド

### Grid（分割数）

| 設定 | タイル数 | 推奨FOV |
|------|---------|---------|
| 2x2 | 4 | 〜30° |
| 3x3 | 9 | 〜60°（推奨） |
| 4x4 | 16 | 〜90° |

広角レンズ（35mm等）で全天撮影する場合は **3x3** が推奨です。

### Overlap（オーバーラップ）

- デフォルト: 100px
- タイル間で共有するピクセル数
- 値が大きいほどWCS統合の精度検証が充実するが、ソルブ時間が増加

### RA/DEC（座標ヒント）

- FITSキーワード `RA`, `DEC`, `OBJCTRA`, `OBJCTDEC` から自動取得
- 未設定の場合、solve-fieldがブラインドソルブを試行（時間がかかる）
- 手動入力する場合は度（degrees）単位

### Pixel Scale

- `FOCALLEN` と `XPIXSZ` から自動計算: `206.265 × XPIXSZ / FOCALLEN`
- 未設定の場合、solve-fieldがスケール推定を試行

## トラブルシューティング

### "Process timed out after 30 minutes"

- 座標ヒント（RA/DEC）が正しいか確認
- ピクセルスケールが大きくずれていないか確認
- solve-fieldがインストールされ、パスが通っているか確認

### "No active image window"

- 画像がPixInsightで開かれていることを確認

### "The active image has not been saved to disk"

- File > Save As でXISFまたはFITS形式で保存してから再実行

### Python環境エラー

- Settings ダイアログで正しいPythonパスを指定しているか確認
- venv環境の場合、`.venv/bin/python`（macOS/Linux）を指定
- 必要パッケージがインストール済みか確認: `pip install -r requirements.txt`

### ソルブ失敗（0 tiles solved）

- インデックスファイルがインストールされているか確認
- 画像のFOVに対してグリッドが細かすぎないか確認（タイルのFOVが小さすぎるとソルブ失敗しやすい）
- RA/DEC ヒントを手動で入力してみる

## 技術仕様

- **PJSR互換**: PixInsight 1.8.9以降
- **通信方式**: ExternalProcess によるPythonプロセス呼び出し
- **設定永続化**: PixInsight Settings API（GlobalSettings）
- **JSON出力**: `--json-output` フラグにより構造化された結果を取得
