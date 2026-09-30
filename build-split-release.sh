#!/bin/bash
#
# build-split-release.sh - SplitImageSolver リポジトリ配布パッケージのビルドスクリプト
#
# 使い方: bash build-split-release.sh
#
# 生成物:
#   repository/SplitImageSolver-{VERSION}.zip  - V8版配布パッケージ (PI 1.9.4+)
#   repository/SplitImageSolver-1.2.0.zip      - SpiderMonkey版 (既存、PI 1.8.9-1.9.3)
#   repository/updates-split.xri               - デュアルプラットフォームリポジトリ XML
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAIN_SCRIPT="${SCRIPT_DIR}/javascript/SplitImageSolver.js"
VERSION=$(grep '#define VERSION ' "$MAIN_SCRIPT" | head -1 | sed 's/.*"\(.*\)".*/\1/')
PACKAGE_NAME="SplitImageSolver"
ZIP_NAME="${PACKAGE_NAME}-${VERSION}.zip"
REPO_DIR="${SCRIPT_DIR}/repository"
TMPDIR_BASE="${SCRIPT_DIR}/.build-tmp-split"

echo "=== ${PACKAGE_NAME} v${VERSION} リリースビルド ==="

# V8版の既存ZIPを削除しないよう注意
# SpiderMonkey版 (1.2.0) は repository/ に保持する

# 0. 署名の検査
# 署名は #include を展開したあとのコードにかかり、無効な #ifdef の中の #include も
# 解決される。PixInsight 同梱のスクリプト（../AdP/ など）を取り込むと、PixInsight の
# 更新で署名が無効になる（2.0.1 が 1.9.5 で "Invalid code signature" になった）
SIGNATURE="${SCRIPT_DIR}/javascript/SplitImageSolver.xsgn"
# 署名の対象になるファイル（本体と、本体が #include するもの）
SIGNED_SOURCES=(
    "${MAIN_SCRIPT}"
    "${SCRIPT_DIR}/javascript/wcs_math.js"
    "${SCRIPT_DIR}/javascript/wcs_keywords.js"
    "${SCRIPT_DIR}/javascript/astrometry_api.js"
)
# 許可するのは同じディレクトリのファイル名だけの #include。それ以外（"../"、絶対パス、
# <...>、サブディレクトリ経由）は PixInsight 同梱スクリプトを取り込みうるので止める
if grep -nE '^[[:space:]]*#include' "${SIGNED_SOURCES[@]}" \
        | grep -vE ':[[:space:]]*#include[[:space:]]+"[A-Za-z0-9_]+\.(js|jsh)"'; then
    echo "ERROR: 同じディレクトリ以外のファイルを #include しています（上の行）。署名が PixInsight の版に縛られます" >&2
    exit 1
fi
# 同じディレクトリにあっても、ブリッジは同梱の AdP を取り込むので止める
if grep -nE '^[[:space:]]*#include[[:space:]]+"imagesolver_bridge\.jsh"' "${SIGNED_SOURCES[@]}"; then
    echo "ERROR: imagesolver_bridge.jsh を #include しています（上の行）。PixInsight 同梱の AdP を取り込むため署名が版に縛られます" >&2
    exit 1
fi
# 本体が #include するのは上の 3 本だけであること（増えたら SIGNED_SOURCES に足す）
INCLUDED=$(grep -hE '^[[:space:]]*#include' "${MAIN_SCRIPT}" | sed -E 's/.*"([^"]+)".*/\1/' | sort | tr '\n' ' ')
if [ "${INCLUDED}" != "astrometry_api.js wcs_keywords.js wcs_math.js " ]; then
    echo "ERROR: 本体の #include が想定と違う: ${INCLUDED}（SIGNED_SOURCES を見直すこと）" >&2
    exit 1
fi
if [ ! -f "${SIGNATURE}" ]; then
    echo "ERROR: ${SIGNATURE} がありません。先に署名してください" >&2
    exit 1
fi
for SRC in "${SIGNED_SOURCES[@]}"; do
    if [ "${SIGNATURE}" -ot "${SRC}" ]; then
        echo "ERROR: 署名が $(basename "${SRC}") より古い。署名し直してください" >&2
        exit 1
    fi
done
# mtime の比較は完全ではない（clone 直後など）。最後の砦は配信前の
# Security.getScriptSignature() による検証（pixinsight-handbook/docs/release.md）

# 1. repository/ ディレクトリ作成
mkdir -p "${REPO_DIR}"

# 2. 一時ディレクトリに PixInsight インストール構造を作成
rm -rf "${TMPDIR_BASE}"
mkdir -p "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}"

# 3. JavaScript ファイルをコピー
cp "${SCRIPT_DIR}/javascript/SplitImageSolver.js" "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/astrometry_api.js"   "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/wcs_math.js"          "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/wcs_keywords.js"      "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/equipment_data.jsh"   "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/equipment.json"       "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"
cp "${SCRIPT_DIR}/javascript/SplitImageSolver.xsgn"  "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"

echo "ファイルをコピーしました:"
ls -la "${TMPDIR_BASE}/src/scripts/${PACKAGE_NAME}/"

# 4. V8版 zip を作成（SpiderMonkey版 1.2.0 は削除しない）
rm -f "${REPO_DIR}/${ZIP_NAME}"
cd "${TMPDIR_BASE}"
zip -r "${REPO_DIR}/${ZIP_NAME}" src/
cd "${SCRIPT_DIR}"

echo "zip を作成しました: repository/${ZIP_NAME}"

# 5. SHA1 計算
SHA1=$(shasum "${REPO_DIR}/${ZIP_NAME}" | awk '{print $1}')
echo "SHA1 (V8版 ${VERSION}): ${SHA1}"

# 6. SpiderMonkey版 SHA1 取得
SM_ZIP="SplitImageSolver-1.2.0.zip"
SM_SHA1=$(shasum "${REPO_DIR}/${SM_ZIP}" | awk '{print $1}')
echo "SHA1 (SpiderMonkey版 1.2.0): ${SM_SHA1}"

# 7. 現在日付
RELEASE_DATE=$(date +%Y%m%d)

# 8. updates-split.xri をデュアルプラットフォーム構成で生成
cat > "${REPO_DIR}/updates-split.xri" << XMLEOF
<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <title>Split Image Solver</title>
      <brief_description>Automatic plate solver using astrometry.net API or local solve-field for PixInsight</brief_description>
   </description>
   <platform os="all" arch="noarch" version="1.8.9:1.9.3">
      <package fileName="${SM_ZIP}"
               sha1="${SM_SHA1}"
               type="script"
               releaseDate="20260320">
         <title>Split Image Solver</title>
         <description>
            <p>Automatic plate solver using astrometry.net API or local solve-field (SpiderMonkey runtime / PixInsight &lt;= 1.9.3)</p>
         </description>
      </package>
   </platform>
   <platform os="all" arch="noarch" version="1.9.4:9.9.9">
      <package fileName="${ZIP_NAME}"
               sha1="${SHA1}"
               type="script"
               releaseDate="${RELEASE_DATE}">
         <title>Split Image Solver</title>
         <description>
            <p>Automatic plate solver using astrometry.net API or local solve-field (V8 runtime / PixInsight &gt;= 1.9.4)</p>
         </description>
      </package>
   </platform>
</xri>
XMLEOF

echo "updates-split.xri を生成しました（デュアルプラットフォーム構成）"

# 9. 一時ディレクトリ削除
rm -rf "${TMPDIR_BASE}"

echo ""
echo "=== ビルド完了 ==="
echo "  SpiderMonkey版: ${REPO_DIR}/${SM_ZIP}  (PI 1.8.9-1.9.3)"
echo "  V8版:           ${REPO_DIR}/${ZIP_NAME}  (PI 1.9.4+)"
echo "  ${REPO_DIR}/updates-split.xri"
