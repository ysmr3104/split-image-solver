# CLAUDE.md

このファイルは、Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

Split Image Solver は、広角星野写真をタイルに分割してプレートソルブし、個別の WCS 解を統合して元画像全体の WCS を生成する PixInsight スクリプトです。astrometry.net API（デフォルト）またはローカル solve-field（Python 経由）の2つのソルブモードに対応。

アーキテクチャ・処理パイプライン・モジュール構成は [docs/architecture.md](docs/architecture.md) を参照。

## コマンド

```bash
# Node.js 単体テスト（SplitImageSolver の純粋関数）
node tests/javascript/test_split_solver.js

# リリースビルド（PixInsight リポジトリパッケージ生成）
bash build-split-release.sh

# Python テスト（Local モード用）
PYTHONPATH="." .venv/bin/pytest tests/python -v
```

## コーディング規約

- **ES5 スタイル必須**: PJSR は `let`/`const`/アロー関数/テンプレートリテラルを未サポート。`var` 宣言のみ使用。
- コード内の変数名・関数名・コメント・コンソール出力（`console.writeln`）は全て英語。
- UI テキスト（ラベル・メッセージボックス）は日本語可。

## 実装上の重要な注意点

- **HTTP 通信**: ExternalProcess + curl で一時ファイル経由。stdout キャプチャは不安定なため一時ファイルを使用。
- **Local モード Python 呼び出し**: `/bin/sh -c` 経由でクォート付きコマンドを実行。macOS GUI アプリは Homebrew PATH を持たないため、Python 実行ファイルのディレクトリ + `/opt/homebrew/bin` + `/usr/local/bin` を PATH に追加。stdout/stderr は一時ファイルにリダイレクト → stderr はリアルタイム表示。
- **FITS 座標 convention（重要）**: PixInsight の `FileFormatInstance.writeImage()` は FITS をトップファースト（y=1 が画像上端）で保存する。astrometry.net が返す CRPIX もこのトップダウン convention に従う。Python/astropy と同じ。
  - **astrometry.net WCS（トップダウン）**: `v = (py + 1) - CRPIX2`。タイルの CRPIX オフセット: `CRPIX2 += offsetY`。`pixelToRaDecTD()` を使用。
  - **WCSFitter 出力（ボトムアップ）**: `v = (height - py) - CRPIX2`。manual-image-solver と同じ FITS 標準 convention。`pixelToRaDec()` を使用。
  - **convertToWcsResult()**: 単一画像ソルブ時に astrometry.net WCS を TD→BU に変換（CRPIX2 反転 + CD/SIP の v 成分符号反転）。
- **タイル CRPIX 逆変換**: ダウンサンプル時は `crpix_original = crpix_downsampled / scaleFactor`、CD 行列は `cd *= scaleFactor`。タイルオフセット適用: `CRPIX1 += offsetX`, `CRPIX2 += offsetY`（トップダウン convention）。
- **投影型別スケール補正**: 非 rectilinear レンズ（equisolid, equidistant, stereographic）ではタイルの画像中心からの角距離に応じてスケールヒントを補正。
- **偽陽性フィルタ**: Pass 2 リトライ時にスケール比 (0.3-3.0 範囲外で拒否) + 座標乖離チェック (>5° で拒否)。
- **制御点書き込み**: SplineWorldTransformation プロパティに直接書き込み。`ControlPoints:Weights` は非標準プロパティで書き込むとバリデーションエラーになるため使用しない。
- **FITSKeyword 値アクセス**: PJSR は `kw.value` を使用（`kw.strippedValue` ではない）。文字列値はクォート除去が必要: `kw.value.trim().replace(/^'|'$/g, "").trim()`。
- **UI 初期化順序**: `updateScaleAndFov()` は `focalLengthEdit`、`pixelPitchEdit`、`fovInfoLabel`、`gridPresets`、`gridCombo` が全て定義された後に呼び出すこと。定義前に呼ぶと undefined エラーになる。

## PixInsight でのテスト

PixInsight でテスト実行する際は、**必ずコンソールログの保存を案内する**こと。スクリプト実行前に以下のコマンドを PixInsight コンソールで実行してもらう。ファイル名には実行時の日付時刻（YYYYMMDD_HHMMSS）を埋め込むこと:

```
log -f="/Users/ysmr/Downloads/pixinsight_split_20260307_154800.log" -a
```

（上記は例。日付時刻部分はその時点の値に置き換える）

ログファイルはテスト結果の分析・比較に使用する。

## 外部依存

- **PixInsight 1.8.9+** — PJSR スクリプト実行環境
- **astrometry.net API キー** — https://nova.astrometry.net/ で取得（無料、API モード用）
- **curl** — HTTP 通信用（OS 標準搭載、API モード用）
- **Python 3.8+** — Local モード用（astropy, scipy, numpy）
- **solve-field** — Local モード用（astrometry.net ローカル版）
- Node.js — テスト実行用（オプション）
