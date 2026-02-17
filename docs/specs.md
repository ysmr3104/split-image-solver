# Split Image Solver — 技術仕様書

## 1. プロジェクト概要

Split Image Solver は、広角〜超広角の星野写真をタイルに分割し、astrometry.net の `solve-field` で各タイルをプレートソルブした後、個別の WCS（World Coordinate System）解を統合して元画像全体の WCS を生成するツールです。

PixInsight の ImageSolver では対応できない広角画像（FOV > 60°）を主な対象としており、フルサイズセンサー + 14mm レンズ（対角 FOV ~147°）のような超広角構成でも動作します。

### 1.1 解決する課題

| 課題 | 原因 | 本ツールのアプローチ |
|------|------|---------------------|
| ImageSolver が広角で失敗する | TAN投影の1枚ソルブではFOV > 60°に対応困難 | 画像をタイル分割し、各タイルを個別にソルブ |
| 広角画像のピクセルスケールが一様でない | gnomonic投影の非線形性 | タイルごとに実効ピクセルスケールを計算 |
| レンズ歪曲収差が星のパターンマッチを妨げる | 樽型歪曲がカタログのquadパターンと不一致 | SIP歪み多項式による補正（次数5まで） |
| 端タイルがソルブ失敗しやすい | スケールヒント不正確、星密度低下 | 2パスソルブ戦略（成功タイルのWCSからヒントを再計算） |

### 1.2 対応フォーマット

- **入力**: FITS (.fits, .fit), XISF (.xisf)
- **出力**: FITS (.fits, .fit), XISF (.xisf)
- **WCS標準**: TAN投影 + SIP歪み多項式（FITS WCS Paper II準拠）

---

## 2. 処理パイプライン

6ステップのパイプラインで構成されます（`python/main.py`）。

```
Step 1: 画像読み込み + 機材自動検出
Step 2: グリッド分割（NxM タイル + オーバーラップ）
Step 3: 1st パス — 各タイルをプレートソルブ（並列実行）
Step 3b: 2nd パス — 失敗タイルをWCS由来ヒントでリトライ
Step 4: WCS収集 + 品質検証
Step 5: WCS統合（重み付き最小二乗法 or 中心タイル法）
Step 6: 出力書き込み（統合WCSを元画像に付与）
```

### 2.1 Step 1: 画像読み込みと機材自動検出

FITS/XISFヘッダーから機材情報を自動判別し、ソルブパラメータを決定します。

**検出フロー:**

1. `INSTRUME` ヘッダー → `config/equipment.yaml` のカメラDB検索（完全一致 → 大小文字無視の部分一致）
2. カメラ検出成功 → `pixel_pitch_um`, `sensor_width_mm` を取得
3. `FOCALLEN` ヘッダー → レンズDB検索（焦点距離 ±0.5mm、カメラメーカー互換性で絞り込み）
4. レンズ検出成功 → `type`（rectilinear/fisheye）を取得

**パラメータ優先順位:**

```
CLI引数 > FITSヘッダー > 機材DB > フォールバック計算
```

**ピクセルスケール計算:**

```
pixel_scale [arcsec/px] = 206.265 × pixel_pitch [μm] / focal_length [mm]
```

### 2.2 Step 2: グリッド分割

`ImageSplitter` が画像をNxMのグリッドに分割します。

**分割パラメータ:**

| パラメータ | 説明 | デフォルト |
|-----------|------|-----------|
| `--grid NxM` | グリッドパターン（例: 3x3, 8x8） | 3x3 |
| `--overlap` | タイル間のオーバーラップ (px) | 100 |

**推奨グリッドサイズ（対角FOV基準）:**

| 対角FOV | 推奨グリッド | 対象レンズ例 |
|---------|-------------|-------------|
| > 150° | 12x8 | 15mm 魚眼 |
| 120°–150° | 10x10 | 8mm 魚眼 |
| 90°–120° | 8x8 | 14mm |
| 60°–90° | 5x5 | 20–24mm |
| 30°–60° | 3x3 | 35–50mm |
| ≤ 30° | 2x2 | 85mm以上 |

**タイルメタデータ:**

各タイルのFITS/XISFヘッダーに以下のメタデータが付与されます:

- `ORIGSIZX`, `ORIGSIZY` — 元画像サイズ
- `SPLITX`, `SPLITY` — グリッド列/行番号
- `OFFSETX`, `OFFSETY` — 元画像内のピクセルオフセット
- `OVERLAP` — オーバーラップピクセル数
- `GRIDCOLS`, `GRIDROWS` — グリッド列数/行数

### 2.3 Step 3: 1st パス — プレートソルブ

`AstrometryLocalSolver` が各タイルに対して `solve-field` を並列実行します。

#### solve-field コマンド構成

```bash
solve-field --overwrite --no-plots --no-remove-lines --no-verify-uniformize \
  --crpix-center --tweak-order 4 \
  [--scale-low X --scale-high Y --scale-units arcsecperpix] \
  [--ra RA --dec DEC --radius RADIUS] \
  [--downsample N] \
  --cpulimit TIMEOUT input.fits
```

| フラグ | 目的 |
|--------|------|
| `--crpix-center` | 歪みの基準点を画像中心に固定（広角で重要） |
| `--tweak-order 4` | SIP多項式次数（タイル単体のフィッティング用） |
| `--no-verify-uniformize` | ソース点均一化チェックをスキップ（高速化） |
| `--no-plots` | プロット生成をスキップ |

#### タイルごとのパラメータ最適化

**実効ピクセルスケール**（後述の「投影型対応とスケール補正」で詳述）:

各タイルの中心位置と投影型に基づき、画像中心からの角度に応じたスケール倍率を算出します。

```python
θ = _pixel_radius_to_angle(r_pixels, center_scale_rad, projection)
effective_scale = center_scale × _effective_pixel_scale_factor(θ, projection)
```

**動的マージン計算**:

画像端に近いタイルほど、スケールの不確実性が大きいためマージンを広げます。

```python
r_ratio = distance_from_center / max_distance  # 0.0〜1.0
scale_margin = 0.2 + 0.3 × r_ratio  # 中心: ±20%, コーナー: ±50%
```

**RA/DECヒント**:

画像中心のRA/DECが既知の場合、投影型に応じた逆投影によりタイルごとの中心座標を算出してヒントとして渡します（詳細は後述）。

#### 自動ダウンサンプリング

```python
if max_dimension > 2000:
    downsample = ceil(max_dimension / 2000)
```

2000px を超えるタイルは自動的にダウンサンプリングされます。solve-field のソース検出は整数画像で最も安定するため、解像度を下げても精度への影響は軽微です。

#### XISF → FITS 一時変換

solve-field は FITS のみ対応のため、XISF タイルは一時的に FITS に変換されます。

- **RGB → ルミナンス**: `L = 0.2126R + 0.7152G + 0.0722B`
- **float32 → uint16**: パーセンタイル (0.5–99.9) クリッピングでスケーリング

#### 並列実行

`ThreadPoolExecutor(max_workers=4)` で並列実行。`as_completed()` で完了順に結果を収集し、ファイルパスをキーとする辞書で管理します。

### 2.4 Step 3b: 2nd パス — WCS由来ヒントでリトライ

1st パスで失敗したタイルに対し、成功タイルのWCSを利用して正確なRA/DECヒントを計算し、リトライします。

#### ヒント計算アルゴリズム

1. 失敗タイルの中心ピクセル座標を算出
2. 最も近い成功タイルを参照として選択（ユークリッド距離）
3. 失敗タイルの中心を、参照タイルのローカル座標に変換
4. 参照タイルのWCSの `pixel_to_world_values()` で天球座標を取得

```python
# 失敗タイルの中心 → 参照タイルのローカル座標
local_x = failed_tile_center_x - ref_tile_x_start
local_y = failed_tile_center_y - ref_tile_y_start

# 参照タイルのWCSで天球座標に変換
tile_ra, tile_dec = ref_wcs.pixel_to_world_values(local_x, local_y)
```

#### 2nd パスのパラメータ

| パラメータ | 値 | 理由 |
|-----------|-----|------|
| スケールマージン | ±50% | 広角端では不確実性が高い |
| タイムアウト | 180秒 | WCS由来の正確なヒントがあるため短縮 |
| 検索半径 | 設定値（デフォルト10°） | RA/DECヒントは精度が高い |

#### 偽陽性フィルタ

2nd パスの結果は以下の2つの基準で検証されます。

**基準1 — スケール整合性:**

```python
scale_ratio = result_scale / median_success_scale
if scale_ratio < 0.3 or scale_ratio > 3.0:
    → REJECTED（スケールが3倍以上/3分の1以下なら偽陽性）
```

**基準2 — 座標整合性:**

```python
coord_deviation = sqrt(ra_diff² + dec_diff²)
if coord_deviation > search_radius × 1.5:
    → REJECTED（ヒント座標から大きく乖離していれば偽陽性）
```

### 2.5 Step 5: WCS統合

`WCSIntegrator` がタイルのWCS解を統合し、元画像全体のWCSを生成します。

#### 統合手法: 重み付き最小二乗法（デフォルト）

4つのステージで構成されます。

**Stage 1 — ベースWCSの構築:**

画像中心に最も近い成功タイルのWCSを取得し、CRPIX を元画像座標に調整します。

```python
# タイルWCSのCRPIXを元画像座標系にオフセット
new_crpix1 = tile_wcs.crpix[0] + tile_offset_x
new_crpix2 = tile_wcs.crpix[1] + tile_offset_y

# 重要: astropy SIPは独自のCRPIXを保持するため別途更新が必要
wcs.sip = Sip(a, b, ap, bp, [new_crpix1, new_crpix2])
```

**Stage 2 — CD行列の最適化:**

全成功タイルから制御点（各タイル100点以上のグリッドサンプリング）を収集し、CD行列の4パラメータを `scipy.optimize.least_squares`（Levenberg-Marquardt法）で最適化します。

```
最適化パラメータ: CD1_1, CD1_2, CD2_1, CD2_2 （4パラメータ）
固定パラメータ: CRVAL1, CRVAL2（画像中心の天球座標）
```

> **設計判断**: CRVAL + CD の6パラメータ同時最適化は広角画像で局所最小に陥りやすいため、CRVAL は中心タイルから固定し、CD 行列のみを最適化します。

**制御点の重み付け:**

```python
distance_weight = 1.0 - (dist_from_center / max_dist) × 0.5  # 中心寄りを重視
solve_time_weight = min(1.0, 30.0 / max(solve_time, 1.0))     # 高速ソルブ = 高品質
scale_weight = 1.0 if pixel_scale else 0.5                     # スケール有 = 信頼性高
total_weight = distance_weight × solve_time_weight × scale_weight
```

**Stage 3 — SIP歪み多項式のフィッティング（後述で詳述）**

**Stage 4 — TAN vs SIP 精度比較:**

```python
if sip_mean_error < tan_mean_error × 0.95:
    → SIP採用（5%以上の改善がある場合）
else:
    → TAN-only（SIPの改善が不十分な場合）
```

#### 統合手法: 中心タイル法（簡易）

中心タイルのWCSのCRPIXをオフセット調整するのみ。最適化やSIPフィッティングは行いません。高速ですが精度は劣ります。

#### オーバーラップ検証

隣接タイルペアのオーバーラップ領域内の格子点（20px間隔）で、双方のWCSから天球座標を算出し、角度差（angular separation）を計測します。

- **報告項目**: 最大誤差、平均誤差、RMS誤差
- **許容値**: デフォルト5 arcsec（超過時は警告を出力し処理を継続）

### 2.6 Step 6: 出力

統合WCSをFITS/XISFヘッダーに書き込みます。SIP係数（A_ORDER, A_i_j, B_ORDER, B_i_j 等）も含めてラウンドトリップ対応しています。

---

## 3. 投影型対応とスケール補正

広角画像のプレートソルブにおいて最も重要な技術的課題は、レンズ投影型の非線形性への対処です。本ツールは4つの投影型をサポートしています。

### 3.1 サポートする投影型

| 投影型 | レンズ種別 | r(θ) の式 | スケール倍率 dθ/dr | CLIでの指定値 |
|--------|-----------|-----------|-------------------|-------------|
| gnomonic | rectilinear（通常レンズ） | r = tan(θ)/s | 1/cos²(θ) | `rectilinear` |
| equisolid | 対角魚眼（大半の魚眼レンズ） | r = 2·sin(θ/2)/s | 1/cos(θ/2) | `fisheye_equisolid` |
| equidistant | 円周魚眼 | r = θ/s | 1（一定） | `fisheye_equidistant` |
| stereographic | 一部の魚眼 | r = 2·tan(θ/2)/s | 1/cos²(θ/2) | `fisheye_stereographic` |

ここで r はピクセル距離、θ は光軸からの角距離、s は中心ピクセルスケール (rad/pixel) です。

**投影型の指定方法:**

- `--lens-type` CLI引数で明示指定
- `--lens` で機材DBに登録済みレンズを指定すると `type` フィールドから自動検出
- PixInsightでは **Fisheye lens** チェックボックス、または機材DB自動マッチングで検出
- デフォルトは `rectilinear`（gnomonic）で後方互換性を維持

### 3.2 問題: 非一様なピクセルスケール

全ての投影型で、光軸（画像中心）から離れるほどピクセルあたりの天球上の角度が変化します。変化の大きさは投影型によって異なります。

```
14mm rectilinear + α7RV の場合:
  中心:        54.4 arcsec/pixel
  エッジ:      87–95 arcsec/pixel（1.6–1.7倍）
  コーナー:    ~113 arcsec/pixel（2.1倍）

15mm fisheye (equisolid) + α7RIV の場合:
  中心:        51.7 arcsec/pixel
  エッジ:      62–66 arcsec/pixel（1.2–1.3倍）
  コーナー:    ~66 arcsec/pixel（1.3倍）
```

gnomonic投影は端でスケールが急激に増大しますが、equisolid投影はより緩やかです。equidistant投影ではスケール倍率が常に1.0（一定）です。

この非線形性を無視して一律のピクセルスケールヒントを solve-field に渡すと、端タイルのスケール範囲が実際の値と合わず、ソルブに失敗します。

### 3.3 タイルごとの実効ピクセルスケール計算

`python/utils/coordinate_transform.py` の `calculate_tile_pixel_scale()` で、投影型に応じた実効スケールを計算します。

**計算フロー:**

```
r = √((tile_x - center_x)² + (tile_y - center_y)²)   [pixels]

# Step 1: 投影型に応じた角距離θを計算 (_pixel_radius_to_angle)
gnomonic:       θ = arctan(r × s)
equisolid:      θ = 2 × arcsin(r × s / 2)    ※ arcsin引数をclamp(-1, 1)
equidistant:    θ = r × s
stereographic:  θ = 2 × arctan(r × s / 2)

# Step 2: 投影型に応じたスケール倍率を計算 (_effective_pixel_scale_factor)
gnomonic:       factor = 1 / cos²(θ)
equisolid:      factor = 1 / cos(θ/2)
equidistant:    factor = 1
stereographic:  factor = 1 / cos²(θ/2)

# Step 3: 実効スケール
scale_effective = scale_center × factor   [arcsec/pixel]
```

### 3.4 投影型対応のRA/DECヒント計算

画像中心の天球座標(α₀, δ₀)が既知の場合、投影型に応じた逆投影で任意のタイル中心のRA/DECを算出します。

`python/utils/coordinate_transform.py` の `pixel_offset_to_radec()`:

```
入力: (α₀, δ₀) = 画像中心の天球座標
      (Δx, Δy) = 画像中心からのピクセルオフセット
      s = 中心ピクセルスケール [arcsec/pixel]
      projection = 投影型

Step 1: 方位角φと画像面上の距離rを計算
  r = √(Δx² + Δy²)
  φ = arctan2(Δx, Δy)

Step 2: 投影型に応じた角距離cを計算
  c = _pixel_radius_to_angle(r, s_rad, projection)

Step 3: 球面三角法で天球座標を計算（投影型非依存）
  δ = arcsin(cos(c)·sin(δ₀) + sin(c)·cos(δ₀)·cos(φ))
  α = α₀ + arctan2(sin(c)·sin(φ), cos(c)·cos(δ₀) - sin(c)·sin(δ₀)·cos(φ))
```

Step 3 の球面三角法は投影型に依存しません。投影型の違いは Step 2 の角距離計算のみに影響します。これにより、新しい投影型の追加は `_pixel_radius_to_angle()` と `_effective_pixel_scale_factor()` に1ケース追加するだけで済みます。

**オフセット符号の注意:**

標準的な天文画像では北が上、東が左のため:

```python
offset_x = image_center_x - tile_center_x   # 東方向が正
offset_y = image_center_y - tile_center_y   # 北方向が正
```

### 3.5 線形近似との精度比較

14mm rectilinear（FOV ~147°）でのコーナータイル:

| 手法 | RA誤差 | DEC誤差 |
|------|--------|---------|
| 線形近似 | 数十度 | 数十度 |
| gnomonic逆投影 | < 0.1° | < 0.1° |

広角画像では線形近似は全く使えず、完全な球面三角法が必須です。

### 3.6 魚眼レンズの対角FOV計算

`--recommend-grid` や PixInsight の推奨グリッド表示では、投影型に応じた正確な対角FOVを計算します。

```
対角ピクセル距離: r_diag = √(W² + H²) / 2

gnomonic:       FOV = 2 × arctan(r_diag × s)
equisolid:      FOV = 2 × 2 × arcsin(r_diag × s / 2)
equidistant:    FOV = 2 × r_diag × s
stereographic:  FOV = 2 × 2 × arctan(r_diag × s / 2)
```

例: Sigma 15mm f/2.8 Fisheye + Sony A7R IV (9533×6344, 3.76µm)
- 中心ピクセルスケール: 51.7"/px
- equisolid 対角FOV: **183.4°**
- 推奨グリッド: **12x8**

---

## 4. SIP歪み多項式

### 4.1 概要

SIP (Simple Imaging Polynomial) は、TAN投影の残差を多項式で補正する FITS WCS 標準の拡張です。レンズの樽型/糸巻き型歪曲や、光学系固有の高次歪みをモデル化します。

### 4.2 数学的定義

TAN投影で得られる理想ピクセル座標 (u, v) に対し、SIP補正を適用:

```
u' = u + A(u, v)
v' = v + B(u, v)

ここで:
  u = x - CRPIX1,  v = y - CRPIX2
  A(u,v) = Σ A_p_q · u^p · v^q   (p+q = 2..N)
  B(u,v) = Σ B_p_q · u^p · v^q   (p+q = 2..N)
```

逆変換（天球→ピクセル）用に AP, BP 係数もフィットされます。

### 4.3 SIP次数の決定

FOV に基づいて動的に決定します:

```python
fov_estimate_deg = pixel_scale_deg × max(image_width, image_height)
sip_order = 5 if fov_estimate_deg > 30 else 3
```

| FOV | SIP次数 | 理由 |
|-----|---------|------|
| > 30° | 5 | 高次歪曲が顕著。5次項まで含めることで残差を十分に小さくできる |
| ≤ 30° | 3 | 低次歪曲が支配的。過剰フィッティングを防ぐ |

### 4.4 フィッティング手法

**入力**: 全成功タイルの制御点（ピクセル座標 + 天球座標）と重み

**Step 1 — 残差の計算:**

```python
# TAN投影のみで天球→ピクセル変換した「理想座標」と、
# 実際のタイル由来の「観測座標」の差が残差
du = x_ideal - x_observed
dv = y_ideal - y_observed
```

**Step 2 — 座標の正規化:**

数値安定性のため、ピクセル座標を最大値で正規化します。

```python
coord_scale = max(|u_max|, |v_max|)
u_norm = u / coord_scale
v_norm = v / coord_scale
```

**Step 3 — 設計行列の構築:**

2次以上の多項式項（u^p · v^q, p+q ≥ 2）を列に持つ設計行列を構築。

**Step 4 — 重み付き最小二乗法:**

```python
# √w を設計行列と残差ベクトルに乗じて重み付き最小二乗法
W·X·a = W·du  →  a = lstsq(W·X, W·du)
W·X·b = W·dv  →  b = lstsq(W·X, W·dv)
```

**Step 5 — 係数のデスケーリング:**

正規化座標で得られた係数を元のスケールに変換:

```python
a_real[p,q] = a_norm[p,q] / coord_scale^(p+q)
```

### 4.5 逆SIP係数の計算

順方向SIPのマッピングを格子点で評価し、逆方向を同様の多項式フィッティングで求めます:

```python
# 順方向: (u, v) → (u', v') = (u + A(u,v), v + B(u,v))
# 逆方向: (u', v') → (u, v) = (u' + AP(u',v'), v' + BP(u',v'))
# AP, BP は -du, -dv を目標値としてフィット
```

### 4.6 TAN vs SIP の自動選択

SIPフィッティング後、全制御点での精度をTAN-onlyと比較し、5%以上の改善がある場合のみSIPを採用します。過剰フィッティングによる精度悪化を防ぐ設計です。

---

## 5. レンズ歪曲収差とプレートソルブ

### 5.1 SEL14F18GM の歪曲収差（lensfunデータ）

Sony FE 14mm f/1.8 GM (SEL14F18GM) は lensfun データベースに登録済みです。

**歪曲収差モデル（PT Lens）:**

```
r_corrected = a·r³ + b·r² + c·r + d·r
  d = 1 - a - b - c

パラメータ (focal = 14.0mm):
  a =  0.01733   (正の3次項)
  b = -0.06263   (負の2次項)
  c =  0.05484   (正の1次項)
  d =  0.99046   (残余項)
```

弱い樽型歪曲で、中間半径（r_norm ≈ 0.5）付近で最大 ~1.8% のスケール増加。

**色収差（TCA）:**

```
Red:   vr = 0.999973, cr = 0.000169
Blue:  vb = 1.000006, cb = 0.000089
→ サブピクセルレベル。プレートソルブには影響なし。
```

**ビネッティング (F2.0):**

```
V(r) = 1 + k1·r² + k2·r⁴ + k3·r⁶
  k1 = -1.3362,  k2 = 0.8269,  k3 = -0.2346
→ コーナーで 30–40% の周辺光量低下。端タイルの暗い星検出に影響。
```

### 5.2 タイル内差分歪みの定量分析

プレートソルブで重要なのは絶対歪み量ではなく、**タイル内での星位置の相対的なずれ**（差分歪み）です。

#### 8x8 グリッド（タイル 1188×792 px）での差分歪み

| タイル | 位置 | 差分歪み (px) | 角度 (arcsec) | タイルFOV比 |
|--------|------|--------------|---------------|-------------|
| (3,3) | 中心 | 4.4 | 242 | 0.37% |
| (2,2) | 内部 | 5.7 | 309 | 0.48% |
| (1,1) | 内部 | 22.8 | 1239 | 1.92% |
| (0,0) | コーナー | 25.2 | 1372 | 2.12% |

#### solve-field の歪み許容度との比較

solve-field の quad パターンマッチングは一般に **~5% の歪み許容度**を持ちます。

- **中心タイル（0.1–0.4%）**: 全く問題なし
- **内部タイル（0.5–2%）**: 許容範囲内
- **コーナータイル（2–2.2%）**: 許容範囲内だが余裕は少ない

### 5.3 結論

SEL14F18GM のタイル内歪曲収差は、プレートソルブ失敗の**主因ではありません**。失敗の主因は:

1. **gnomonic投影の非線形性** — 中心〜コーナーでスケール2倍以上の差
2. **インデックスファイルのクワッドスケール不足** — エッジタイルの大クワッドに非対応
3. **地上景** — 下端の星なし領域

ただし、lensfun による事前歪み補正は WCS 統合時の残差低減に寄与し、最終的な座標精度の改善が見込めます。

---

## 6. 機材データベース

### 6.1 構成

`config/equipment.yaml` にカメラとレンズの仕様を定義しています。

**カメラ定義例:**

```yaml
cameras:
  "Sony ILCE-7RM5":
    maker: Sony
    display_name: "Sony α7RV"
    sensor_width_mm: 35.9
    sensor_height_mm: 24.0
    pixel_pitch_um: 3.76
    native_resolution: [9504, 6336]
    crop_factor: 1.0
    lensfun_maker: Sony
    lensfun_model: ILCE-7RM5
```

**レンズ定義例:**

```yaml
lenses:
  "Sony FE 14mm f/1.8 GM":
    maker: Sony
    display_name: "SEL14F18GM"
    type: rectilinear
    focal_length_mm: 14.0
    max_aperture: 1.8
    camera_makers: [Sony]
    lensfun_maker: Sony
    lensfun_search: "FE 14mm"
```

### 6.2 対応機材一覧

**カメラ（37機種）:**

Sony α7 シリーズ全世代:
- α7 / α7II / α7III / α7IV / α7V（スタンダード）
- α7R / α7RII / α7RIII / α7RIV / α7RV（高画素）
- α7S / α7SII / α7SIII（高感度）
- α7C / α7CII / α7CR（コンパクト）

Nikon Z シリーズ:
- Z 5 / Z 5II / Z 6 / Z 6II / Z 6III / Z f（24MPクラス）
- Z 7 / Z 7II / Z 8 / Z 9（45MPクラス）

Canon EOS R シリーズ:
- EOS R / RP / R3 / R6 / R6 II / R6 III / R8（スタンダード〜高速連写）
- EOS R5 / R5 II / R1（高画素 / フラッグシップ）

**レンズ（27本）:**

| メーカー | モデル | 焦点距離 | 開放F値 |
|---------|--------|---------|---------|
| Sony GM | SEL14F18GM | 14mm | f/1.8 |
| Sony GM | SEL24F14GM | 24mm | f/1.4 |
| Sony GM | SEL35F14GM | 35mm | f/1.4 |
| Sony G | SEL20F18G | 20mm | f/1.8 |
| Sony G | SEL24F28G | 24mm | f/2.8 |
| Sigma Art | 14mm f/1.4 DG DN | 14mm | f/1.4 |
| Sigma Art | 20mm f/1.4 DG DN | 20mm | f/1.4 |
| Sigma Art | 35mm f/1.2 DG DN | 35mm | f/1.2 |
| Sigma Art | 35mm f/1.4 DG DN | 35mm | f/1.4 |
| Sigma Contemp. | 24mm f/2 DG DN | 24mm | f/2.0 |
| Sigma Contemp. | 24mm f/3.5 DG DN | 24mm | f/3.5 |
| Sigma Contemp. | 35mm f/2 DG DN | 35mm | f/2.0 |
| NIKKOR Z S | 20mm f/1.8 S | 20mm | f/1.8 |
| NIKKOR Z S | 24mm f/1.8 S | 24mm | f/1.8 |
| NIKKOR Z S | 35mm f/1.2 S | 35mm | f/1.2 |
| NIKKOR Z S | 35mm f/1.8 S | 35mm | f/1.8 |
| NIKKOR Z | 26mm f/2.8 | 26mm | f/2.8 |
| NIKKOR Z | 28mm f/2.8 | 28mm | f/2.8 |
| NIKKOR Z | 35mm f/1.4 | 35mm | f/1.4 |
| Canon RF L | 14mm f/1.4 L VCM | 14mm | f/1.4 |
| Canon RF L | 20mm f/1.4 L VCM | 20mm | f/1.4 |
| Canon RF L | 24mm f/1.4 L VCM | 24mm | f/1.4 |
| Canon RF L | 35mm f/1.4 L VCM | 35mm | f/1.4 |
| Canon RF | 16mm f/2.8 STM | 16mm | f/2.8 |
| Canon RF | 24mm f/1.8 Macro STM | 24mm | f/1.8 |
| Canon RF | 28mm f/2.8 STM | 28mm | f/2.8 |
| Canon RF | 35mm f/1.8 Macro STM | 35mm | f/1.8 |

### 6.3 CLIからの機材DB参照

```bash
# 機材DB一覧をJSON出力
python main.py --list-equipment

# 推奨グリッドサイズを計算
python main.py --recommend-grid \
  --focal-length 14 --pixel-pitch 3.76 \
  --image-width 9728 --image-height 6656
```

---

## 7. PixInsight GUI 連携

### 7.1 概要

`javascript/SplitImageSolver.js` は PixInsight PJSR (PixInsight JavaScript Runtime) スクリプトで、GUIからPythonバックエンドを `ExternalProcess` 経由で呼び出します。

### 7.2 パラメータ渡し方式

GUI は `--focal-length` と `--pixel-pitch` を直接 Python に渡します。これにより Python 側のタイルごと gnomonic 補正が有効になります。

```javascript
// PixInsight GUI → Python
args.push("--focal-length", params.focalLength.toString());
args.push("--pixel-pitch", params.pixelPitch.toString());
```

> **設計判断**: 以前の方式では JS 側で `pixelScale = 206.265 × pixelPitch / focalLength` を計算して `--pixel-scale` を渡していましたが、この方式では Python 側のタイルごとスケール計算が機能しません。焦点距離とピクセルピッチを分離して渡すことで、Python 側で各タイル位置に応じた正確なスケール計算が可能になりました。

### 7.3 結果ファイル方式

Python の JSON 出力は stdout ではなく、一時ファイル経由で受け渡します。

```javascript
var resultFile = File.systemTempDirectory + "/split_solver_result.json";
args.push("--result-file", resultFile);
```

**理由**: PJSR の `ExternalProcess` で stdout をキャプチャする際、ライブラリの出力が混入したり、バッファリングの問題で JSON が正しく受信できないケースがありました。ファイル経由なら確実に受け渡せます。

### 7.4 PJSR JSON 互換性

PJSR の `JSON.parse()` には以下の制約があり、Python 側で対策しています。

#### 科学表記法の非対応

PJSR は `1.23e-06` のような科学表記法を解析できません。SIP 係数は非常に小さい値（1e-18 程度）になることがあるため、すべて固定小数点に変換します。

```python
# 正規表現で科学表記を検出し、固定小数点に変換
re.sub(r"-?\d+\.?\d*[eE][+-]?\d+", _sci_to_fixed, json_str)
# 例: 1.23e-06 → 0.00000123
```

#### 過剰な小数桁数の非対応

CD 行列の値（例: `-0.011146900363256357`、18桁）のような長い小数をPJSRは解析できません。

```python
def _sanitize_floats_for_pjsr(obj):
    """全浮動小数点数を12有効桁・最大15桁小数に丸める"""
    if isinstance(obj, float):
        magnitude = math.floor(math.log10(abs(obj)))
        decimal_places = max(0, min(15, 12 - int(magnitude) - 1))
        return round(obj, decimal_places)
```

この2段階の処理（精度丸め + 科学表記除去）により、PJSR で安全に解析可能な JSON を生成します。

### 7.5 WCS キーワードの直接適用

ソルブ結果の WCS キーワードは、PixInsight のウィンドウに直接書き込みます。これによりファイルの再読み込みが不要になり、STF（Screen Transfer Function）、ウィンドウ位置、ズーム状態が保持されます。

```javascript
// 1. 既存WCSキーワードを除去
// 2. 新しいWCSキーワードを追加
window.keywords = cleanedKw;
// 3. アストロメトリックソリューション表示を再生成
window.regenerateAstrometricSolution();
```

WCS キーワードが利用できない場合のフォールバックとして、ファイル再読み込み + STF/位置/ズーム復元も実装されています。

### 7.6 完了時の出力表示

ソルブ完了時、Process Console に以下の情報を表示します。

**完了バナー:**

```
    .       *           .       *       .           *
        .       .   *       .       .       *
  +=========================================+
  |                                         |
  |     * SPLIT IMAGE SOLVER - SOLVED! *    |
  |                                         |
  +=========================================+
        *       .           *       .       .
    .       .       *   .       *       .       *
```

**機材情報:**

```
Equipment: Camera: Sony α7RV | Lens: SEL14F18GM | FL: 14mm | Pitch: 3.76um
```

**ソルブ結果サマリ:**

```
Result: 13/64 tiles solved, CRVAL=(274.3456, -14.9012), 54.40"/px
```

**タイル成否グリッド:**

```
Tile solve grid (8x8):
       0 1 2 3 4 5 6 7
  0    . . . . . . . .
  1    . . . O . . . .
  2    . . . O O O . .
  3    . . O O O O . .
  4    . . O O O O . .
  5    . . . O . . . .
  6    . . . . . . . .
  7    . . . . . . . .
  (O=solved, .=failed)
```

**中心・四隅の座標（ImageSolver 風）:**

```
Image coordinates:
  Center ........ RA: 18 17 22.94  Dec: -14 54 04.3
  Top-Left ...... RA: 20 48 12.35  Dec: +42 18 56.1
  Top-Right ..... RA: 15 47 05.88  Dec: +42 13 22.7
  Bottom-Left ... RA: 20 45 18.62  Dec: -72 06 15.4
  Bottom-Right .. RA: 15 43 51.10  Dec: -72 00 41.9
  Field of view . 147.52 x 101.31, diagonal 157.42 deg
  Pixel scale ... 54.40 arcsec/px
```

---

## 8. CLI リファレンス

### 8.1 基本的な使い方

```bash
# 基本実行
python main.py --input image.xisf --output solved.xisf --grid 3x3

# 超広角画像の実行例
python main.py \
  --input 14mm_drizzle.xisf \
  --output 14mm_solved.xisf \
  --grid 8x8 \
  --overlap 100 \
  --focal-length 14 \
  --pixel-pitch 3.76 \
  --ra 274.3 --dec -14.9
```

### 8.2 主要オプション

| オプション | 型 | 説明 |
|-----------|-----|------|
| `--input` | str | 入力画像パス（FITS/XISF） |
| `--output` | str | 出力画像パス |
| `--grid` | str | グリッドパターン（例: 3x3, 8x8） |
| `--overlap` | int | タイル間オーバーラップ（px） |
| `--focal-length` | float | 焦点距離 (mm) |
| `--pixel-pitch` | float | ピクセルピッチ (μm) |
| `--pixel-scale` | float | ピクセルスケール直接指定 (arcsec/px) |
| `--ra` | float | 画像中心RA (度) |
| `--dec` | float | 画像中心DEC (度) |
| `--camera` | str | カメラINSTRUME名（機材DB検索用） |
| `--lens` | str | レンズ名（機材DB検索用） |
| `--method` | str | WCS統合手法（weighted_least_squares / central_tile） |

### 8.3 ユーティリティモード

| オプション | 説明 |
|-----------|------|
| `--list-equipment` | 機材データベースをJSON出力 |
| `--recommend-grid` | 推奨グリッドサイズを計算 |
| `--json-output` | 結果をJSON形式でstdoutに出力 |
| `--result-file` | 結果JSONをファイルに書き出し |

---

## 9. 実測データ

### 9.1 テスト構成

| 項目 | 値 |
|------|-----|
| カメラ | Sony α7RV (ILCE-7RM5) |
| レンズ | Sony FE 14mm f/1.8 GM |
| 撮影絞り | F2.0 |
| 画像サイズ | 9728×6656 (drizzle後) |
| 中心ピクセルスケール | ~54.4 arcsec/pixel |
| 対角FOV | ~147° |
| グリッド | 8×8 (64タイル) |

### 9.2 ソルブ結果

| パス | 成功 | 失敗 | 偽陽性 | 実質成功率 |
|------|------|------|--------|-----------|
| 1st パス | 11/64 | 53 | — | 17.2% |
| 2nd パス | +4 | — | 2 | — |
| **最終** | **13/64** | 49 | 2排除 | **20.3%** |

### 9.3 成功パターン

```
     col0  col1  col2  col3  col4  col5  col6  col7
row0  .     .     .     .     .     .     .     .     ← 上端
row1  .     .     .     O     .     .     .     .
row2  .     .     .     O     O     O     .     .
row3  .     .     O     O     O     O     .     .     ← 画像中心
row4  .     .     O     O     O     O     .     .
row5  .     .     .     O     .     .     .     .
row6  .     .     .     .     .     .     .     .     ← 地上景
row7  .     .     .     .     .     .     .     .     ← 地上景
```

成功タイルは画像中心付近（行2–5, 列2–5）に集中。エッジ/コーナーの失敗原因は gnomonic 投影の非線形性とインデックスファイルのスケール不足。下端2行は地上景のため星なし。

---

## 10. ファイル構成

```
split-image-solver/
├── python/
│   ├── main.py                          # CLIエントリーポイント、パイプライン制御
│   ├── image_splitter.py                # 画像読み込み、グリッド分割
│   ├── wcs_integrator.py                # WCS統合（最小二乗法、SIPフィッティング）
│   ├── fits_handler.py                  # FITS I/O、WCSヘッダー操作
│   ├── xisf_handler.py                  # XISF I/O、SIP係数ラウンドトリップ
│   ├── solvers/
│   │   ├── base_solver.py               # ソルバー抽象インターフェース
│   │   ├── astrometry_local_solver.py   # solve-field ラッパー
│   │   └── factory.py                   # ソルバーファクトリー
│   └── utils/
│       ├── coordinate_transform.py      # 投影型対応の座標変換、タイルスケール計算
│       ├── equipment.py                 # 機材DB操作
│       └── logger.py                    # ロガー設定
├── javascript/
│   └── SplitImageSolver.js              # PixInsight PJSR GUI スクリプト
├── config/
│   ├── equipment.yaml                   # 機材データベース
│   ├── settings.json                    # 実行時設定（gitignore対象）
│   └── settings.example.json            # 設定テンプレート
├── tests/
│   └── python/
│       ├── test_coordinate_transform.py # 投影型対応テスト（38件）
│       ├── test_image_splitter.py       # グリッド分割テスト
│       ├── test_wcs_integrator.py       # WCS統合テスト
│       ├── test_list_equipment.py       # 機材DB・推奨グリッドテスト
│       └── test_astrometry_local_solver.py
└── docs/
    ├── specs.md                         # 本仕様書
    ├── ultra-wide-angle-solve-report.md # 超広角ソルブ報告書
    └── ASTROMETRY_NET_SETUP.md          # astrometry.netセットアップガイド
```

---

## 11. 外部依存

### 必須

| パッケージ | 用途 |
|-----------|------|
| astrometry.net (`solve-field`) | プレートソルブエンジン |
| astropy | WCS操作、FITS I/O、天球座標計算 |
| numpy | 配列演算 |
| scipy | 最小二乗最適化 |
| PyYAML | 機材データベース読み込み |

### オプション

| パッケージ | 用途 |
|-----------|------|
| xisf + lxml | XISF フォーマット対応 |
| lensfunpy | レンズ歪み補正（将来実装） |

### astrometry.net セットアップ

```bash
# macOS
brew install astrometry-net netpbm

# インデックスファイル（対象FOVに合わせて選択）
# 4110-4119: クワッドスケール 2'–35'（標準）
# 4100-4107: クワッドスケール 60'以上（超広角用）
```

---

## 12. 既知の制限と将来の改善

### 現在の制限

1. **地上景タイル**: 星が写っていない領域はソルブ不可能（改善不可）
2. **極端な歪みのエッジタイル**: FOV > 120° のコーナータイルは成功率が低い
3. **インデックスファイル依存**: 大スケールクワッド用インデックスが不足するとエッジタイルが失敗
4. **2nd パスの処理時間**: 失敗タイルが多い場合、リトライに時間がかかる

### 将来の改善候補

1. **lensfunpy統合**: ソルブ前にレンズ歪曲収差を除去 → 精度向上
2. **自己キャリブレーション**: 成功タイルのSIPから画像全体の歪みモデルを推定
3. **大スケール用インデックスの自動取得**: 不足インデックスの検出と推奨
