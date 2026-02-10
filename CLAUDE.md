# CLAUDE.md

このファイルは、Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

Split Image Solver は、広角星野写真をタイルに分割し、astrometry.net の `solve-field` で各タイルをプレートソルブし、個別の WCS（World Coordinate System）解を統合して元画像全体の WCS を生成するツールです。PixInsight の ImageSolver では対応できない超広角画像（例: フルサイズセンサー + 35mmレンズ、約60° FOV）を対象としています。

## コマンド

```bash
# .venv を使用すること（venv/ は依存パッケージ不足のため使用不可）
source .venv/bin/activate

# ソルバー実行
.venv/bin/python python/main.py --input image.xisf --output solved.xisf --grid 3x3 --overlap 100

# 全テスト実行
PYTHONPATH="." .venv/bin/pytest tests/python -v

# 単一テスト実行
PYTHONPATH="." .venv/bin/pytest tests/python/test_image_splitter.py::test_grid_pattern_parsing -v

# リント（Black フォーマットチェック）
.venv/bin/black --check --diff python/ tests/

# 自動フォーマット
.venv/bin/black python/ tests/

# 依存パッケージインストール
.venv/bin/pip install -r requirements.txt
```

`python/main.py` が `from image_splitter import ImageSplitter` のような相対インポートを使用するため、`PYTHONPATH="."` が必須。

## アーキテクチャ

### 処理パイプライン（`python/main.py` の6ステップ）

1. **読み込み** — FITS または XISF 画像を読み込み（`image_splitter.load_image` または `XISFHandler.load_image`）
2. **分割** — `ImageSplitter` が画像をオーバーラップ付きの NxM グリッドタイルに分割し、各タイルをオフセットメタデータ（`OFFSETX`, `OFFSETY`, `SPLITX`, `SPLITY`）付きで FITS/XISF として保存
3. **プレートソルブ** — `AstrometryLocalSolver` が各タイルに対して `solve-field` を並列実行（`ThreadPoolExecutor`）。XISF タイルは一時的に FITS に変換される（RGB→ルミナンス、float32→uint16）。ヒント指定時はタイルごとの RA/DEC ヒントを画像中心から計算
4. **WCS 収集** — ソルブ成功した `astropy.wcs.WCS` オブジェクトを収集
5. **WCS 統合** — `WCSIntegrator` がタイルの WCS 解を統合:
   - **weighted_least_squares**（デフォルト）: 全タイルから制御点を収集し、中心タイルの WCS をベースとして CD 行列を `scipy.optimize.least_squares` で最適化、必要に応じて SIP 歪み多項式をフィット
   - **central_tile**: 中心タイルの WCS の CRPIX をオフセット分調整するだけの簡易手法
6. **出力書き込み** — 統合した WCS を出力 FITS/XISF ファイルに書き込み

### 主要モジュール

- `python/main.py` — CLI エントリーポイントとパイプライン制御
- `python/image_splitter.py` — 画像読み込みとグリッド分割
- `python/wcs_integrator.py` — オーバーラップ検証と SIP フィッティングを含む WCS 統合
- `python/solvers/astrometry_local_solver.py` — `solve-field` サブプロセスラッパー
- `python/solvers/base_solver.py` — ソルバー抽象インターフェース（`solve_image`, `batch_solve`）
- `python/solvers/factory.py` — ソルバーファクトリー（現在は常に `AstrometryLocalSolver` を返す）
- `python/fits_handler.py` — FITS ファイル I/O と WCS ヘッダー操作
- `python/xisf_handler.py` — XISF ファイル I/O、メタデータ変換、SIP 係数のラウンドトリップ
- `python/utils/coordinate_transform.py` — タイルごとのヒント用ピクセルオフセット→RA/DEC 変換
- `javascript/SplitImageSolver.js` — `ExternalProcess` 経由で `python/main.py` を呼び出す PixInsight PJSR GUI スクリプト

### 実装上の重要な注意点

- **SIP CRPIX の同期**: タイル WCS の CRPIX を元画像座標に調整する際、`wcs.sip.crpix` も別途更新が必要。astropy の SIP は独自の CRPIX を保持している。
- **`as_completed` の順序**: `concurrent.futures.as_completed` は完了順で返すため、投入順ではない。結果はファイルパスをキーとする辞書で管理すること。
- **XISF SIP ラウンドトリップ**: `_fits_keywords_to_wcs` が FITS キーワードから SIP 係数（A_ORDER, A_i_j 等）を読み込み、`_wcs_to_fits_keywords` が書き戻す。双方向の同期を維持すること。
- **solve-field v0.97**: フラグは `--no-verify-uniformize`（`--no-verify-uniformly` ではない）。
- **solve-field 用 RGB XISF**: ソース抽出前にルミナンスに変換し、float32→uint16 にスケーリングが必要。
- **座標オフセットの符号**: 標準的な天文画像では X, Y 両方のオフセット符号が反転する: `offset = image_center - tile_center`。
- **WCS 最適化**: 広角では CD 行列のみ（4パラメータ）を最適化し、CRVAL は中心タイルから固定。CRVAL+CD の同時最適化（6パラメータ）は局所最小に陥る。
- **SIP 次数**: FOV > 30° では次数5、それ以外では次数3を使用。

## 設定

- `config/settings.json`（gitignore 対象）— 実行時設定。`config/settings.example.json` からコピーして作成。
- 主要設定: `astrometry_local.solve_field_path` — `null` にすると `solve-field` を自動検出。

## 外部依存

- **astrometry.net**（`solve-field`）のローカルインストールが必要: macOS では `brew install astrometry-net`
- 対象画像の FOV に合った星カタログ（インデックスファイル）のダウンロードが必要
