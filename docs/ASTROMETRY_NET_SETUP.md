# Astrometry.net セットアップガイド

## Astrometry.net Online API

### APIキーの取得

1. [nova.astrometry.net](http://nova.astrometry.net/) にアクセス
2. アカウントを作成（またはログイン）
3. 「My Profile」→「API」タブからAPIキーをコピー
4. `config/settings.json` に設定:

```json
{
  "astrometry": {
    "api_key": "YOUR_API_KEY_HERE",
    "timeout": 900
  }
}
```

または環境変数で設定:

```bash
export ASTROMETRY_NET_API_KEY="YOUR_API_KEY_HERE"
```

### 使用方法

```bash
python3 python/main.py \
  --input image.fits \
  --output solved.fits \
  --solver astrometry
```

### 注意事項

- インターネット接続が必要
- APIレート制限あり（並列数はデフォルト2に制限）
- 1画像あたり1〜5分程度かかる
- 無料プランでは商用利用不可

## Astrometry.net Local（solve-field）

### インストール

#### macOS（Homebrew）

```bash
brew install astrometry-net
```

#### Linux（apt）

```bash
# Ubuntu / Debian
sudo apt-get install astrometry.net astrometry-data-tycho2
```

#### ソースからビルド

```bash
# 依存関係のインストール
sudo apt-get install libcfitsio-dev libcairo2-dev python3-dev \
  libjpeg-dev libnetpbm-dev netpbm wcslib-dev zlib1g-dev

# ソースを取得してビルド
git clone https://github.com/dstndstn/astrometry.net.git
cd astrometry.net
make
make install
```

### 星カタログ（Index Files）の設定

solve-fieldで正常にプレートソルブするには、対象の視野角に合った星カタログが必要です。

#### カタログのダウンロード

公式のインデックスファイルは以下から取得:
http://data.astrometry.net/

| インデックスシリーズ | 対応視野範囲 | サイズ |
|-------------------|------------|--------|
| 4200 | 2° - 2.8° | 〜40MB/ファイル |
| 4100 | 30' - 1° | 〜200MB/ファイル |
| 5200 (Tycho-2) | 7' - 19' | 〜1GB 合計 |

#### macOS（Homebrew）でのカタログ配置

```bash
# カタログ保存先の確認
brew --prefix astrometry-net
# → /opt/homebrew/share/astrometry/data/

# カタログのダウンロード（例: 4100シリーズ）
cd /opt/homebrew/share/astrometry/data/
wget http://data.astrometry.net/4100/index-4110.fits
wget http://data.astrometry.net/4100/index-4111.fits
# ...必要なファイルをダウンロード
```

#### Linux でのカタログ配置

```bash
# デフォルトの保存先
ls /usr/share/astrometry/

# カタログの追加
sudo wget -P /usr/share/astrometry/ \
  http://data.astrometry.net/4200/index-4219.fits
```

### config/settings.json の設定例

```json
{
  "astrometry_local": {
    "solve_field_path": null,
    "timeout": 600,
    "search_radius": 10.0
  }
}
```

- `solve_field_path`: solve-fieldコマンドのパス（`null`の場合は自動検出）
- `timeout`: タイムアウト秒数
- `search_radius`: RA/DECヒント使用時の検索半径（度）

### 使用方法

```bash
python3 python/main.py \
  --input image.fits \
  --output solved.fits \
  --solver astrometry_local
```

### 動作確認

```bash
# solve-fieldが使えるか確認
solve-field --help

# 簡単なテスト
solve-field --overwrite --no-plots test_image.fits
```

## トラブルシューティング

### solve-fieldが見つからない

```
FileNotFoundError: solve-field command not found
```

`config/settings.json` で `solve_field_path` を明示的に指定してください:

```json
{
  "astrometry_local": {
    "solve_field_path": "/opt/homebrew/bin/solve-field"
  }
}
```

### 星カタログが不足している

```
No index files found
```

対象画像の視野角に合ったインデックスファイルをダウンロードしてください。

### APIキーが無効

```
Astrometry.net login failed
```

APIキーを再確認してください。[nova.astrometry.net](http://nova.astrometry.net/) のプロフィールページで確認できます。
