# テスト戦略

Split Image Solver のテストは 4 層構成で、上位ほど外部依存が増え実行時間が長くなる。

## テスト体系

| 層 | 略称 | 正式名 | 目的 | 実行環境 | 所要時間 |
|----|------|--------|------|---------|---------|
| L1 | UT | ユニットテスト | 純粋関数の数学的正しさ | Node.js / pytest | 数秒 |
| L2a | IT-Solver | インテグレーションテスト Solver | 正しいヒントを与えて per-tile ソルブの動作確認 | solve-field 必要 | 数分 |
| L2b | IT-Wavefront | インテグレーションテスト Wavefront | wavefront パイプライン全体の性能ゲート | solve-field 必要 | 数分〜十数分 |
| L3 | E2E | E2Eテスト | PixInsight GUI から全パイプライン | PixInsight（手動） | 数十分 |

### UT (L1)

外部サービス・バイナリに依存せず、関数の数学的正しさを検証する。

| ファイル | テスト件数 | テスト対象 |
|---------|-----------|-----------|
| `tests/ut/test_functions.js` | 145 | `projectionScale()`, `pixelToRaDec`, `convertToWcsResult`, `validateOverlap`, 偽陽性フィルタ, `mergeWcsSolutions` 制御点数 |
| `tests/ut/test_hint_propagation.js` | 162 | `computeTileHints`, `solveWavefront` ヒント伝播（モックソルバー） |
| `tests/ut/test_api_regression.js` | 34 | API フィクスチャとの WCS / スケール回帰テスト |

### IT-Solver (L2a)

**目的**: wavefront パイプラインを通さず、フィクスチャから事前定義した精密ヒント（RA/DEC/スケール範囲）を直接与えて per-tile ソルブの動作を確認する。ソルバー単体の性能を検証する層。

- ヒントは `tile_hints_local_*.json` フィクスチャから取得
- `batch_success=true` のタイルのみをソルブ対象とする
- **Local 版** (solve-field): Python `run_single_tile_solve` を呼び出し
- **API 版** (astrometry.net): PJSR の `solveSingleTile` を VM context で呼び出し

### IT-Wavefront (L2b)

**目的**: `computeTileHints` → `solveWavefront` のパイプライン全体を実行し、ヒント伝播 + ソルブの統合動作を検証する。wavefront がベースライン相当のタイル数を解けることを性能ゲートとして機能させる。

- ヒントは `tile_wcs_*.json` フィクスチャの hints セクションから初期ヒントを構築
- 全タイルを wavefront 順序でソルブ（中心から外側へ伝播）
- **Local 版** (solve-field): `child_process.spawnSync` で直接 solve-field を呼び出し
- **API 版** (astrometry.net): `AstrometryClient` + `solveSingleTile` を VM context で呼び出し

### E2E (L3)

PixInsight GUI 上で手動実行。スクリプト実行前にコンソールログの保存を行う。自動化テストの範囲外。

---

## データセット一覧

| データセット | レンズ | カメラ | 画像サイズ | グリッド | 投影 |
|-------------|--------|--------|-----------|---------|------|
| 2x2 | EF 50mm F1.8 STM | Canon EOS 6D | 6037 x 4012 | 2 x 2 | rectilinear |
| 8x6 | Sony FE 14mm F1.8 GM | Sony α7S | 9728 x 6656 | 8 x 6 | rectilinear |
| equisolid_8x6 | Sigma 15mm F2.8 EX DG Fisheye | Sony α7RIV | 9533 x 6344 | 8 x 6 | equisolid |
| equisolid_12x8 | AstrHori 6.5mm F2.0 Fish-Eye | Sony α6100 | 6024 x 4024 | 12 x 8 | equisolid |

---

## IT テスト詳細

### 2x2 (rectilinear, EF 50mm)

| 項目 | 値 |
|------|-----|
| center RA / DEC | 83.3426° / +0.1601° |
| スケール推定 | 24.549 "/px |
| メジアンスケール | 23.080 "/px |
| ベースライン | **4/4 成功** |
| IT-Solver 判定 | solved >= 4 (全タイル成功必須) |
| IT-Wavefront 判定 | solved >= baseline - 0 |

**テストファイル**:

| テスト種別 | ファイル |
|-----------|---------|
| IT-Solver Local | `tests/it/local/test_solver_2x2.py` |
| IT-Wavefront Local | `tests/it/local/test_wavefront_2x2.js` |
| IT-Solver API | `tests/it/api/test_solver_2x2.js` |
| IT-Wavefront API | `tests/it/api/test_wavefront_2x2.js` |

### 8x6 (rectilinear, Samyang 14mm)

| 項目 | 値 |
|------|-----|
| center RA / DEC | 273.8535° / -18.5036° |
| スケール推定 | 54.121 "/px |
| メジアンスケール | 49.633 "/px |
| ベースライン | **8/48 成功** |
| IT-Solver 判定 | solved >= batch_solved - 2 |
| IT-Wavefront 判定 | solved >= baseline - 2 |

**テストファイル**:

| テスト種別 | ファイル |
|-----------|---------|
| IT-Solver Local | `tests/it/local/test_solver_8x6.py` |
| IT-Wavefront Local | `tests/it/local/test_wavefront_8x6.js` |
| IT-Solver API | `tests/it/api/test_solver_8x6.js` |
| IT-Wavefront API | `tests/it/api/test_wavefront_8x6.js` |

### equisolid_8x6 (Sigma 15mm 対角魚眼)

| 項目 | 値 |
|------|-----|
| center RA / DEC | 284.5477° / -27.9803° |
| スケール推定 | 51.546 "/px |
| メジアンスケール | 49.9999 "/px |
| ベースライン | **12/48 成功** |
| IT-Solver Local 判定 | solved >= batch_solved - 2 |
| IT-Wavefront Local 判定 | solved >= baseline - 2 |
| IT-Solver API 判定 | solved >= max(batch_solved - 4, 1) |
| IT-Wavefront API 判定 | solved >= baseline - 4 |

魚眼レンズは周辺部の歪みが大きく、API はサーバー側の変動もあるため Local より許容幅を広く取る。

**テストファイル**:

| テスト種別 | ファイル |
|-----------|---------|
| IT-Solver Local | `tests/it/local/test_solver_equisolid_8x6.py` |
| IT-Wavefront Local | `tests/it/local/test_wavefront_equisolid_8x6.js` |
| IT-Solver API | `tests/it/api/test_solver_equisolid_8x6.js` |
| IT-Wavefront API | `tests/it/api/test_wavefront_equisolid_8x6.js` |

### equisolid_12x8 (AstrHori 6.5mm 超広角魚眼)

| 項目 | 値 |
|------|-----|
| center RA / DEC | 33.2553° / +37.8353° |
| スケール推定 | 123.898 "/px |
| メジアンスケール | 125.877 "/px |
| ベースライン | **4/96 成功** |
| IT-Solver 判定 | solved >= 1 |
| IT-Wavefront 判定 | solved >= 1 |

超広角魚眼（対角 185°）は解けるタイルが極めて少ないため、最低 1 タイル成功を判定基準とする。

**テストファイル**:

| テスト種別 | ファイル |
|-----------|---------|
| IT-Solver Local | `tests/it/local/test_solver_equisolid_12x8.py` |
| IT-Wavefront Local | `tests/it/local/test_wavefront_equisolid_12x8.js` |
| IT-Solver API | `tests/it/api/test_solver_equisolid_12x8.js` |
| IT-Wavefront API | `tests/it/api/test_wavefront_equisolid_12x8.js` |

---

## テスト実行コマンド

```bash
# UT（高速、外部依存なし）
node tests/ut/test_functions.js
node tests/ut/test_hint_propagation.js
node tests/ut/test_api_regression.js

# IT-Solver Local（solve-field + タイル FITS 必要）
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_2x2.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_8x6.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_equisolid_8x6.py -v -s
PYTHONPATH="." .venv/bin/pytest tests/it/local/test_solver_equisolid_12x8.py -v -s

# IT-Wavefront Local（solve-field + タイル FITS 必要）
node tests/it/local/test_wavefront_2x2.js
node tests/it/local/test_wavefront_8x6.js
node tests/it/local/test_wavefront_equisolid_8x6.js
node tests/it/local/test_wavefront_equisolid_12x8.js

# IT-Solver API（astrometry.net API 実呼び出し、低速）
node tests/it/api/test_solver_2x2.js
node tests/it/api/test_solver_8x6.js
node tests/it/api/test_solver_equisolid_8x6.js
node tests/it/api/test_solver_equisolid_12x8.js

# IT-Wavefront API（astrometry.net API 実呼び出し、低速）
node tests/it/api/test_wavefront_2x2.js
node tests/it/api/test_wavefront_8x6.js
node tests/it/api/test_wavefront_equisolid_8x6.js
node tests/it/api/test_wavefront_equisolid_12x8.js
```

---

## フィクスチャ

### ディレクトリ構造

```
tests/
  fixtures/
    tile_wcs_api_2x2.json                ← WCS + タイル情報（IT-Wavefront 用）
    tile_wcs_api_8x6.json
    tile_wcs_equisolid_8x6.json
    tile_wcs_equisolid_12x8.json
    tile_hints_local_2x2.json            ← 精密ヒント（IT-Solver 用）
    tile_hints_local_8x6.json
    tile_hints_local_equisolid_8x6.json
    tile_hints_local_equisolid_12x8.json
  fits_downsampling/
    2x2/                                 ← 4 タイル FITS
    8x6/                                 ← 48 タイル FITS
    equisolid_8x6/                       ← 48 タイル FITS
    equisolid_12x8/                      ← 96 タイル FITS
```

### フィクスチャの役割

- **`tile_wcs_*.json`**: IT-Wavefront で使用。画像全体の初期ヒント（center RA/DEC, スケール推定, 投影型）とタイルごとの位置・サイズ・WCS 結果を保持。wavefront パイプラインはこの初期ヒントから `computeTileHints` でタイル別ヒントを計算する。
- **`tile_hints_local_*.json`**: IT-Solver で使用。タイルごとの精密ヒント（RA/DEC, スケール上下限）を事前定義。wavefront を通さずソルバー単体の動作を検証するために使う。

---

## ベースライン成功タイル一覧

以下は各データセットで `batch_success=true`（PixInsight + astrometry.net の実測でソルブ成功）のタイル情報。IT-Solver テストはこれらのタイルのみをソルブ対象とする。

### 2x2 (rectilinear) — 4/4 成功

| row | col | RA hint (°) | DEC hint (°) | scale_lower ("/px) | scale_upper ("/px) |
|-----|-----|-------------|--------------|--------------------|--------------------|
| 0 | 0 | 93.0 | +6.0 | 12.80 | 38.41 |
| 0 | 1 | 73.9 | +6.3 | 12.80 | 38.41 |
| 1 | 0 | 92.9 | -6.3 | 12.80 | 38.41 |
| 1 | 1 | 73.8 | -6.1 | 12.80 | 38.41 |

### 8x6 (rectilinear) — 8/48 成功

| row | col | RA hint (°) | DEC hint (°) | scale_lower ("/px) | scale_upper ("/px) |
|-----|-----|-------------|--------------|--------------------|--------------------|
| 1 | 3 | 264.7 | +5.0 | 32.91 | 98.73 |
| 1 | 4 | 251.8 | -5.8 | 32.91 | 98.73 |
| 2 | 3 | 275.0 | -6.4 | 28.32 | 84.97 |
| 2 | 4 | 261.1 | -18.1 | 28.32 | 84.97 |
| 3 | 2 | 297.8 | -6.0 | 33.83 | 101.49 |
| 3 | 3 | 286.6 | -18.2 | 28.32 | 84.96 |
| 3 | 4 | 272.5 | -30.4 | 28.32 | 84.96 |
| 3 | 5 | 256.5 | -40.3 | 33.83 | 101.49 |

### equisolid_8x6 (Sigma 15mm 対角魚眼) — 12/48 成功

| row | col | RA hint (°) | DEC hint (°) | scale_lower ("/px) | scale_upper ("/px) |
|-----|-----|-------------|--------------|--------------------|--------------------|
| 1 | 2 | 322.0 | -24.8 | 30.1 | 90.2 |
| 1 | 3 | 307.0 | -16.4 | 27.8 | 83.3 |
| 1 | 4 | 294.2 | -6.1 | 27.8 | 83.3 |
| 1 | 5 | 282.7 | +5.5 | 30.0 | 90.1 |
| 2 | 2 | 313.6 | -37.3 | 28.2 | 84.7 |
| 2 | 3 | 297.2 | -28.0 | 39.8 | 65.2 |
| 2 | 4 | 283.9 | -16.9 | 26.2 | 78.7 |
| 2 | 5 | 272.5 | -4.6 | 28.2 | 84.6 |
| 3 | 2 | 303.3 | -49.8 | 28.2 | 84.7 |
| 3 | 3 | 285.3 | -39.2 | 26.2 | 78.7 |
| 3 | 4 | 276.6 | -25.2 | 26.2 | 78.7 |
| 3 | 5 | 261.1 | -13.8 | 28.2 | 84.6 |

### equisolid_12x8 (AstrHori 6.5mm 超広角魚眼) — 4/96 成功

| row | col | RA hint (°) | DEC hint (°) | scale_lower ("/px) | scale_upper ("/px) |
|-----|-----|-------------|--------------|--------------------|--------------------|
| 3 | 7 | 49.8 | +29.1 | 68.2 | 204.6 |
| 4 | 6 | 30.7 | +35.2 | 97.5 | 155.6 |
| 4 | 7 | 52.4 | +34.0 | 68.2 | 204.6 |
| 5 | 6 | 39.8 | +54.8 | 68.2 | 204.7 |
