# Astrometry.net Local（solve-field）セットアップガイド

## インストール

### macOS（Homebrew）

```bash
brew install astrometry-net netpbm
```

- `netpbm` は `solve-field` が内部で使用する `pnmfile` コマンドを提供します（**必須**）
- `astrometry-net` だけでは `solve-field` が正常に動作しません

### Linux（apt）

```bash
# Ubuntu / Debian
sudo apt-get install astrometry.net astrometry-data-tycho2
```

### ソースからビルド

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

## astrometry.cfg の確認

`solve-field` は設定ファイル `astrometry.cfg` を読み込み、インデックスファイルの配置場所を決定します。**セットアップで最もハマりやすいポイント**がこの設定です。

### 設定ファイルの場所

```bash
# macOS (Homebrew) の場合
cat /opt/homebrew/etc/astrometry.cfg
```

### 確認すべき項目

`astrometry.cfg` の中で `addpath` 行を確認してください:

```bash
cat /opt/homebrew/etc/astrometry.cfg | grep addpath
# 出力例: addpath /opt/homebrew/share/astrometry/data
```

この `addpath` が指すディレクトリにインデックスファイルを配置する必要があります。

### よくある問題

Homebrew のバージョンアップ時に `addpath` のパスが変わることがあります。例えば:

- `addpath /opt/homebrew/Cellar/astrometry-net/0.97/data` → バージョンアップで存在しなくなる
- `addpath /opt/homebrew/share/astrometry/data` → Homebrew のシンボリックリンク先（推奨）

`addpath` が指すディレクトリが実在し、インデックスファイルがあることを必ず確認してください。

## 星カタログ（インデックスファイル）の設定

solve-field でプレートソルブするには、撮影画像の FOV（視野角）に合ったインデックスファイルが必要です。

### レンズ焦点距離とインデックスの対応

| レンズ焦点距離 | FOV (フルサイズ) | タイル FOV (3x3分割時) | 必要なインデックス |
|--------------|-----------------|---------------------|------------------|
| 24mm | ~74° | ~26° | 4110 ~ 4119 |
| 35mm | ~54° | ~19° | 4110 ~ 4119 |
| 50mm | ~40° | ~14° | 4112 ~ 4118 |
| 85mm | ~24° | ~9° | 4115 ~ 4119, 4200 シリーズ |
| 135mm | ~15° | ~6° | 4200 シリーズ |

**ポイント**: 分割後の各タイルの FOV に合ったインデックスが必要です。元画像の FOV ではなく、タイルの FOV で選んでください。

### インデックスシリーズの概要

公式のインデックスファイルは http://data.astrometry.net/ からダウンロードできます。

| インデックスシリーズ | 対応視野範囲 | サイズ | 用途 |
|-------------------|------------|--------|------|
| 4100 (index-4110 ~ 4119) | 30' ~ 1° (タイル FOV 6° ~ 22°) | ~200MB/ファイル | 広角レンズ向け |
| 4200 (index-4200 ~ 4219) | 2' ~ 2.8° (タイル FOV ~6°) | ~40MB/ファイル | 中望遠レンズ向け |
| 5200 (Tycho-2) | 7' ~ 19' | ~1GB 合計 | 望遠鏡向け |

### ダウンロード手順（macOS）

```bash
# 1. addpath のディレクトリを確認
cat /opt/homebrew/etc/astrometry.cfg | grep addpath
# → addpath /opt/homebrew/share/astrometry/data

# 2. そのディレクトリに移動
cd /opt/homebrew/share/astrometry/data

# 3. インデックスファイルをダウンロード

# 広角レンズ（24-50mm）向け: 4100 シリーズ全体
for i in $(seq 4110 4119); do
  curl -O http://data.astrometry.net/4100/index-${i}.fits
done

# 中望遠レンズ（85mm以上）の場合は 4200 シリーズも追加
for i in $(seq 4200 4219); do
  curl -O http://data.astrometry.net/4200/index-${i}.fits
done
```

### ダウンロード手順（Linux）

```bash
# デフォルトの保存先
ls /usr/share/astrometry/

# カタログの追加（例: 4100 シリーズ）
cd /usr/share/astrometry/
for i in $(seq 4110 4119); do
  sudo wget http://data.astrometry.net/4100/index-${i}.fits
done
```

## セットアップの検証

すべてのセットアップが完了したら、以下の手順で動作確認してください。

### 1. solve-field の動作確認

```bash
solve-field --help
```

ヘルプメッセージが表示されれば OK です。

### 2. インデックスファイルの確認

```bash
# addpath のディレクトリを確認
cat /opt/homebrew/etc/astrometry.cfg | grep addpath

# インデックスファイルが存在するか確認
ls /opt/homebrew/share/astrometry/data/index-41*.fits
```

ファイルがリストされれば OK です。

### 3. 実際にソルブしてみる（オプション）

テスト画像がある場合:

```bash
solve-field --overwrite --no-plots test_image.fits
```

## config/settings.json について

`astrometry.cfg` が正しく設定されていれば、`config/settings.json` で `solve_field_path` を指定する必要はありません（`null` のままで自動検出されます）。

```json
{
  "astrometry_local": {
    "solve_field_path": null,
    "timeout": 600,
    "search_radius": 10.0
  }
}
```

- `solve_field_path`: solve-field コマンドのパス（`null` = 自動検出。通常は変更不要）
- `timeout`: タイムアウト秒数
- `search_radius`: RA/DEC ヒント使用時の検索半径（度）

`solve-field` が PATH に見つからない場合のみ、明示的にパスを指定してください:

```json
{
  "astrometry_local": {
    "solve_field_path": "/opt/homebrew/bin/solve-field"
  }
}
```

## トラブルシューティング

### solve-field が見つからない

```
FileNotFoundError: solve-field command not found
```

**解決方法:**
1. `brew install astrometry-net` でインストール
2. または `config/settings.json` で `solve_field_path` を明示的に指定

### インデックスファイルが見つからない / All tile solves failed

```
No index files found
```

**解決方法:**

```bash
# 1. astrometry.cfg の addpath を確認
cat /opt/homebrew/etc/astrometry.cfg | grep addpath

# 2. そのディレクトリにインデックスファイルがあるか確認
ls /opt/homebrew/share/astrometry/data/index-*.fits

# 3. ファイルがなければダウンロード（上記「ダウンロード手順」参照）

# 4. addpath が誤っている場合は astrometry.cfg を修正
#    例: addpath を実際にファイルがあるディレクトリに変更
```

### pnmfile が見つからない

```
pnmfile: command not found
```

`netpbm` がインストールされていません:

```bash
brew install netpbm
```
