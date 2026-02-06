# Astrometry.net統合 実装計画

**作成日**: 2026-02-06
**目的**: 超広角フィールド（35mm以下、>20 arcsec/pixel）のプレートソルブ対応

## 背景

### 現在の制限
- ASTAPは35 arcsec/pixelの超広角フィールドを解決できない
- テスト: 35mmレンズ（6024x4024、35"/pix）→ 全データベース（D50/D20/W08/V05）で失敗
- 根本原因: 粗いピクセルスケールで星のパターンマッチング困難

### Astrometry.netの利点
- 超広角・広視野に強い（0.1° - 180°対応）
- 粗いピクセルスケールでも動作（100 arcsec/pixel以上も可能）
- 大規模な星カタログ（2MASS, Gaia等）を使用
- スケール推定が不要（複数スケールを自動検索）

### デメリット
- 処理時間が長い（数分～数十分/画像）
- インストールが複雑（Python, 星カタログ、依存関係多数）
- macOSでのセットアップに課題あり

## 実装アーキテクチャ

### 設計方針
プレートソルバーを抽象化し、ASTAP/Astrometry.netを切り替え可能にする。

```
main.py
  ↓
SolverFactory (新規)
  ↓
  ├─ ASTAPSolver (既存)
  └─ AstrometryNetSolver (新規)
       ↓
       ├─ ローカル版（solve-field）
       └─ オンラインAPI版（nova.astrometry.net）
```

## 実装フェーズ

### Phase 1: アーキテクチャのリファクタリング（1-2時間）

**目標**: プレートソルバーの抽象化

#### タスク
1. **ベースクラスの作成**
   - `python/solvers/base_solver.py`
   ```python
   class BasePlateSolver(ABC):
       @abstractmethod
       def solve(self, image_path, fov_hint=None, ra_hint=None, dec_hint=None):
           """単一画像のプレートソルブ"""
           pass

       @abstractmethod
       def batch_solve(self, image_paths, **kwargs):
           """バッチプレートソルブ"""
           pass
   ```

2. **ASTAPSolverのリファクタリング**
   - `python/astap_solver.py` → `python/solvers/astap_solver.py`
   - `BasePlateSolver`を継承
   - 既存機能は維持

3. **SolverFactoryの作成**
   - `python/solvers/factory.py`
   ```python
   def create_solver(solver_type: str, **config) -> BasePlateSolver:
       if solver_type == "astap":
           return ASTAPSolver(**config)
       elif solver_type == "astrometry":
           return AstrometryNetSolver(**config)
       else:
           raise ValueError(f"Unknown solver: {solver_type}")
   ```

4. **main.pyの更新**
   - コマンドライン引数に `--solver` を追加
   - デフォルト: `astap`
   - `SolverFactory`経由でソルバー取得

**成果物**:
- ✅ プレートソルバーの切り替えが可能
- ✅ 既存のASTAP機能は完全に維持
- ✅ 新しいソルバーの追加が容易

### Phase 2: Astrometry.net オンラインAPI版（2-3時間）

**目標**: 最小限の実装でAstrometry.netを動作させる

#### タスク
1. **AstrometryNetSolverの基本実装**
   - `python/solvers/astrometry_net_solver.py`
   - オンラインAPI（nova.astrometry.net）のみ対応
   - 画像アップロード → ジョブ投入 → 結果取得

2. **API通信の実装**
   ```python
   class AstrometryNetAPI:
       def __init__(self, api_key=None):
           self.base_url = "http://nova.astrometry.net/api/"
           self.api_key = api_key

       def upload_image(self, image_path):
           """画像をアップロード"""

       def check_job_status(self, job_id):
           """ジョブステータス確認"""

       def get_wcs(self, job_id):
           """WCS情報を取得"""
   ```

3. **WCS形式変換**
   - Astrometry.net形式（FITS Header） → 内部形式
   - 既存の`_read_wcs_from_ini()`に相当する処理

4. **テスト**
   - バラ星雲画像（35mm）で動作確認
   - タイムアウト処理の実装（最大10-15分）

**制限事項**:
- ⚠️ インターネット接続必須
- ⚠️ 処理時間が長い（5-15分/画像）
- ⚠️ APIレート制限あり
- ⚠️ プライベート画像をアップロードする必要

**成果物**:
- ✅ 超広角フィールドが解決可能に
- ✅ インストール不要で即座に利用可能

### Phase 3: Astrometry.net ローカル版（オプション、3-5時間）

**目標**: プライバシー保護と高速化

#### タスク
1. **ローカル版の検出**
   ```python
   def find_solve_field():
       """solve-fieldコマンドのパスを検出"""
       # Homebrew, apt, manual install等に対応
   ```

2. **solve-fieldコマンドの実行**
   ```python
   def solve_local(self, image_path, **options):
       cmd = [
           self.solve_field_path,
           '--scale-low', str(scale_low),
           '--scale-high', str(scale_high),
           '--scale-units', 'arcsecperpix',
           '--no-plots',
           image_path
       ]
       # 実行してWCSファイルを読み取り
   ```

3. **星カタログの管理**
   - 必要なindex fileの自動ダウンロード
   - または手動インストール手順のドキュメント化

4. **macOSサポート**
   - Homebrewインストール手順
   - または代替手段（Docker等）

**成果物**:
- ✅ インターネット不要
- ✅ 高速（1-3分/画像）
- ✅ プライバシー保護

### Phase 4: 統合とテスト（1-2時間）

#### タスク
1. **統合テスト**
   - M31画像（249mm, 3.83"/pix）→ ASTAP
   - バラ星雲（35mm, 35"/pix）→ Astrometry.net
   - 自動フォールバック: ASTAP失敗時にAstrometry.netを試行

2. **ドキュメント更新**
   - README.mdに使用方法を追加
   - Astrometry.netのセットアップ手順
   - パフォーマンス比較表

3. **設定ファイルサポート**
   ```json
   {
     "solver": "astap",
     "fallback_solver": "astrometry",
     "astrometry": {
       "mode": "online",
       "api_key": "your-api-key",
       "timeout": 900
     }
   }
   ```

**成果物**:
- ✅ 完全に動作する2ソルバー対応システム
- ✅ ユーザーフレンドリーな設定

## 実装順序（推奨）

### 第1週: 基盤構築
1. Phase 1: アーキテクチャリファクタリング（即座に開始可能）
2. Phase 2: オンラインAPI版（最も価値が高い）

### 第2週以降: オプション機能
3. Phase 3: ローカル版（ニーズに応じて）
4. Phase 4: 統合とドキュメント

## 技術的な課題と対策

### 課題1: Astrometry.net API の使い方
**対策**:
- 公式ドキュメント: http://astrometry.net/doc/net/api.html
- Python APIクライアント例: https://github.com/dstndstn/astrometry.net/tree/main/net/client

### 課題2: XISF形式のサポート
**対策**:
- Astrometry.netはFITS形式のみ
- XISF → FITS変換を実装（Astropyで可能）
- または一時的にFITSで保存

### 課題3: 処理時間の長さ
**対策**:
- プログレス表示の実装
- タイムアウト設定
- 並列処理の検討（複数タイルを同時投入）

### 課題4: macOSでのローカル版インストール
**対策**:
- Homebrewパッケージの確認
- Docker imageの提供を検討
- オンライン版を推奨

## 必要なリソース

### 新規ファイル
```
python/solvers/
  ├── __init__.py
  ├── base_solver.py          # ベースクラス
  ├── astap_solver.py         # 既存のリファクタリング
  ├── astrometry_net_solver.py # 新規
  └── factory.py              # ファクトリー
```

### 依存パッケージ（追加）
```
requests>=2.28.0      # API通信用
```

### ドキュメント
```
docs/
  ├── ASTROMETRY_NET_SETUP.md    # セットアップガイド
  ├── SOLVER_COMPARISON.md       # ソルバー比較
  └── ASTROMETRY_NET_PLAN.md     # このファイル
```

## 期待される成果

### 定量的成果
- 対応ピクセルスケール範囲: 3"/pix → 100"/pix以上
- 対応焦点距離: 249mm → 10mm以下も対応
- 処理可能FOV: 10° → 180°

### 定性的成果
- ユーザーが超広角レンズで撮影した画像も処理可能
- 柔軟なソルバー選択
- 将来的な拡張が容易

## 次のアクション

1. **Phase 1開始**: アーキテクチャリファクタリング
   - `python/solvers/`ディレクトリ作成
   - `BasePlateSolver`クラス実装
   - 既存コードのリファクタリング

2. **Phase 2開始**: オンラインAPI版実装
   - Astrometry.net APIアカウント登録
   - `AstrometryNetSolver`クラス実装
   - バラ星雲画像でテスト

実装を開始しますか？
