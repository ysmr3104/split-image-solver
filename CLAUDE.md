# CLAUDE.md

このファイルは、Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

Split Image Solver は、広角星野写真をタイルに分割し、astrometry.net API で各タイルをプレートソルブし、個別の WCS 解を統合して元画像全体の WCS を生成する PixInsight スクリプトです。Python 不要の純粋 PJSR ネイティブ実装。

## アーキテクチャ

### PJSR ネイティブ構成（JavaScript のみ、Python 不要）

```
PixInsight (PJSR のみ)
├── SplitImageSolver.js    — メインスクリプト（UI + エンジン）
├── astrometry_api.js      — astrometry.net API クライアント（curl 経由）
├── wcs_math.js            — WCS 数学ライブラリ（manual-image-solver と共有）
├── wcs_keywords.js        — FITS キーワードユーティリティ（同上）
└── equipment.json         — 機材 DB（カメラ・レンズ）
```

### コーディング規約

- **ES5 スタイル必須**: PJSR は `let`/`const`/アロー関数/テンプレートリテラルを未サポート。`var` 宣言のみ使用。
- コード内の変数名・関数名・コメント・コンソール出力（`console.writeln`）は全て英語。
- UI テキスト（ラベル・メッセージボックス）は日本語可。

### 処理パイプライン

**単一画像モード (1x1)**:
1. 画像を FITS に書き出し → astrometry.net API にアップロード
2. ソルブ完了を待機 → calibration + WCS FITS をダウンロード
3. WCS パラメータを解析 → WCSFitter で CD 行列 + SIP フィット
4. FITS キーワード + 制御点を画像に適用

**分割モード (NxM)**:
1. 画像をオーバーラップ付き NxM タイルに分割（FITS 一時保存 + ダウンサンプル）
2. Pass 1: 全タイルを API でソルブ
3. Pass 2: 失敗タイルを成功タイルの WCS ヒントで再試行（retryFailedTiles）
4. オーバーラップ検証: 隣接タイルの WCS 整合性チェック（validateOverlap）
5. 全成功タイルの WCS から制御点を収集 → WCSFitter で統合 WCS を生成（mergeWcsSolutions）
6. 統合 WCS を元画像に適用

### 主要モジュール

- **`javascript/SplitImageSolver.js`** — メインスクリプト。UI（SplitSolverDialog）、タイル分割（splitImageToTiles）、タイルソルブ（solveMultipleTiles）、2パスリトライ（retryFailedTiles）、オーバーラップ検証（validateOverlap）、WCS 統合（mergeWcsSolutions）、WCS 適用（applyWCSToImage, setCustomControlPoints）を含む。
- **`javascript/astrometry_api.js`** — AstrometryClient クラス。ExternalProcess + curl で astrometry.net API（login → upload → pollSubmission → pollJob → getCalibration → getWcsFile）を呼び出す。
- **`javascript/wcs_math.js`** — WCS 数学ライブラリ。WCSFitter（CD 行列 + SIP フィット）、tanProject/tanDeproject（TAN 投影）、pixelToRaDec/raDecToPixel、angularSeparation 等。manual-image-solver と共有。PJSR + Node.js 両対応。
- **`javascript/wcs_keywords.js`** — FITS WCS キーワードユーティリティ（isWCSKeyword, makeFITSKeyword）。
- **`javascript/equipment.json`** — 機材データベース（カメラ 39 機種 + レンズ/鏡筒 24 種）。

### 実装上の重要な注意点

- **HTTP 通信**: ExternalProcess + curl で一時ファイル経由。stdout キャプチャは不安定なため一時ファイルを使用。
- **FITS 座標 convention（重要）**: PixInsight の `FileFormatInstance.writeImage()` は FITS をトップファースト（y=1 が画像上端）で保存する。astrometry.net が返す CRPIX もこのトップダウン convention に従う。Python/astropy と同じ。
  - **astrometry.net WCS（トップダウン）**: `v = (py + 1) - CRPIX2`。タイルの CRPIX オフセット: `CRPIX2 += offsetY`。`pixelToRaDecTD()` を使用。
  - **WCSFitter 出力（ボトムアップ）**: `v = (height - py) - CRPIX2`。manual-image-solver と同じ FITS 標準 convention。`pixelToRaDec()` を使用。
  - **convertToWcsResult()**: 単一画像ソルブ時に astrometry.net WCS を TD→BU に変換（CRPIX2 反転 + CD/SIP の v 成分符号反転）。
- **タイル CRPIX 逆変換**: ダウンサンプル時は `crpix_original = crpix_downsampled / scaleFactor`、CD 行列は `cd *= scaleFactor`。タイルオフセット適用: `CRPIX1 += offsetX`, `CRPIX2 += offsetY`（トップダウン convention）。
- **投影型別スケール補正**: 非 rectilinear レンズ（equisolid, equidistant, stereographic）ではタイルの画像中心からの角距離に応じてスケールヒントを補正。
- **偽陽性フィルタ**: Pass 2 リトライ時にスケール比 (0.3-3.0 範囲外で拒否) + 座標乖離チェック (>5° で拒否)。
- **制御点書き込み**: SplineWorldTransformation プロパティに直接書き込み。`ControlPoints:Weights` は非標準プロパティで書き込むとバリデーションエラーになるため使用しない。
- **FITSKeyword 値アクセス**: PJSR は `kw.value` を使用（`kw.strippedValue` ではない）。文字列値はクォート除去が必要: `kw.value.trim().replace(/^'|'$/g, "").trim()`。

## コマンド

```bash
# Node.js 単体テスト（SplitImageSolver の純粋関数）
node tests/javascript/test_split_solver.js

# リリースビルド（PixInsight リポジトリパッケージ生成）
bash build-split-release.sh

# レガシー Python テスト
PYTHONPATH="." .venv/bin/pytest tests/python -v
```

## PixInsight でのテスト

PixInsight でテスト実行する際は、**必ずコンソールログの保存を案内する**こと。スクリプト実行前に以下のコマンドを PixInsight コンソールで実行してもらう。ファイル名には実行時の日付時刻（YYYYMMDD_HHMMSS）を埋め込むこと:

```
log -f="/Users/ysmr/Downloads/pixinsight_split_20260307_154800.log" -a
```

（上記は例。日付時刻部分はその時点の値に置き換える）

ログファイルはテスト結果の分析・比較に使用する。

## 外部依存

- **PixInsight 1.8.9+** — PJSR スクリプト実行環境
- **astrometry.net API キー** — https://nova.astrometry.net/ で取得（無料）
- **curl** — HTTP 通信用（OS 標準搭載）
- Node.js — テスト実行用（オプション）
