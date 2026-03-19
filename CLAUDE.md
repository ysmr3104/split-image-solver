# CLAUDE.md

このファイルは、Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

Split Image Solver は、広角星野写真をタイルに分割してプレートソルブし、個別の WCS 解を統合して元画像全体の WCS を生成する PixInsight スクリプトです。astrometry.net API（デフォルト）またはローカル solve-field（Python 経由）の2つのソルブモードに対応。

アーキテクチャ・処理パイプライン・モジュール構成は [docs/architecture.md](docs/architecture.md) を参照。

## テスト体系

| 略称 | 正式名 | 内容 | 実行環境 |
|------|--------|------|---------|
| UT | ユニットテスト | 純粋関数の数学的正しさ。外部依存なし | Node.js / pytest |
| IT-Solver | インテグレーションテスト Solver | 正しいヒントを与えて per-tile ソルブの動作確認 | solve-field 必要 |
| IT-Wavefront | インテグレーションテスト Wavefront | wavefront パイプライン全体の性能ゲート | solve-field 必要 |
| IT-Solver IS | インテグレーションテスト Solver (ImageSolver) | per-tile IS ソルブの動作確認 | PixInsight 必要（手動） |
| IT-Wavefront IS | インテグレーションテスト Wavefront (ImageSolver) | IS wavefront パイプライン全体の性能ゲート | PixInsight 必要（手動） |
| E2E | E2Eテスト | PixInsight GUI から全パイプライン | PixInsight 必要（手動） |

### テスト実施ルール

- **テスト実施前に必ずコミットする**: IT/UT を実行する前に、変更を全てコミットしておくこと。テスト結果がどのコミットに対するものかを明確にするため。
- **テスト完了後に Issue へ報告する**: テスト完了時は、関連 Issue のコメントに以下を投稿すること:
  - 実施したテストの種別（UT / IT-Wavefront Local / IT-Wavefront API など）
  - テスト対象のコミットハッシュ（`git rev-parse --short HEAD`）
  - テスト結果サマリ（成功数/失敗数、ベースライン比較）
- **ベースラインからの劣化は即 NG**: IT テストでベースラインから1タイルでも成功数が減少した場合はリグレッションとして即座に NG 判定すること。テスト側に許容幅（-2 など）があっても、それを「許容範囲内」と判断してはならない。
- **IT テストは単独で実行する**: solve-field や astrometry.net API を使う IT テストは並列実行するとリソース競合で結果が不安定になる。必ず1テストずつ順番に実行すること。
- **API テストの FAIL は即ノックアウトではないが必ず報告する**: astrometry.net API はサーバー側の状態に依存するため、Local と同じ成功率が出ないことがある。FAIL でも即座に原因とは断定せず報告すること。
- **性能向上時はベースラインを更新する**: 修正により成功タイル数がベースラインを上回った場合は、テストコード内のベースライン値を新しい成功数に更新すること。
- **性能向上時は IT-Solver フィクスチャも更新する**: IT-Wavefront で新たに成功したタイルがある場合、対応する `tile_hints_local_*.json` フィクスチャの `batch_success` を `true` に更新し、`ra_hint`/`dec_hint` を wavefront が算出した精緻化ヒントに置き換え、`batch_solved` を新しい成功数に更新すること。更新後に IT-Solver を実行して per-tile ソルブが通ることを確認する。
- **IT-Solver は IT-Wavefront の結果に応じて実施する**: IT-Solver は個別タイルのソルブ動作を検証するテスト。wavefront の enqueue 戦略やヒント計算のみの変更では IT-Wavefront で十分であり、IT-Solver は以下の場合に実施する:
  - IT-Wavefront で予期しない失敗タイルが出た場合（ソルバー本体の問題かヒントの問題かの切り分け）
  - ソルバー呼び出しロジック（`solveSingleTile` 等）に直接変更を入れた場合

### テスト実行コマンド

```bash
# UT（高速、外部依存なし）
node tests/ut/test_functions.js
node tests/ut/test_hint_propagation.js
node tests/ut/test_api_regression.js
PYTHONPATH="." .venv/bin/pytest tests/ut/ -v

# IT-Solver（solve-field + タイル FITS 必要）
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_2x2.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_8x6.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_equisolid_8x6.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_equidistant_12x8.py -v -s

# IT-Wavefront（solve-field + タイル FITS 必要）
node tests/it/local/test_wavefront_2x2.js
node tests/it/local/test_wavefront_8x6.js
node tests/it/local/test_wavefront_equisolid_8x6.js
node tests/it/local/test_wavefront_equidistant_12x8.js

# IT-Solver API（astrometry.net API 実呼び出し、低速）
node tests/it/api/test_solver_2x2.js
node tests/it/api/test_solver_8x6.js
node tests/it/api/test_solver_equisolid_8x6.js
node tests/it/api/test_solver_equidistant_12x8.js

# IT-Wavefront API（astrometry.net API 実呼び出し、低速）
node tests/it/api/test_wavefront_2x2.js
node tests/it/api/test_wavefront_8x6.js
node tests/it/api/test_wavefront_equisolid_8x6.js
node tests/it/api/test_wavefront_equidistant_12x8.js

# IT-Solver IS（PixInsight + ImageSolver 必要、手動実行専用）
bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_solver_is_2x2.js

# IT-Wavefront IS（PixInsight + ImageSolver 必要、手動実行専用）
bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_is_2x2.js
bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_is_8x6.js
bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_is_equisolid_8x6.js
bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_wavefront_is_equidistant_12x8.js

# リリースビルド
bash build-split-release.sh
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
