#!/usr/bin/env bash
# run_pjsr_tests.sh
# PixInsight automation-mode でPJSRテストスクリプトを実行し、
# 結果JSONの "failed" が 0 なら exit 0、それ以外は exit 1 を返す。
#
# 使い方:
#   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_split_tiles.js
#   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/hello_automation.js

set -euo pipefail

PIXINSIGHT="${PIXINSIGHT_PATH:-/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESULT_DIR="${PROJECT_ROOT}/tests/pjsr/results"

# PixInsight の存在確認
if [ ! -x "$PIXINSIGHT" ]; then
    echo "ERROR: PixInsight が見つかりません: $PIXINSIGHT" >&2
    echo "  PIXINSIGHT_PATH 環境変数でパスを指定してください。" >&2
    exit 1
fi

# スクリプト引数の確認
if [ $# -eq 0 ]; then
    echo "Usage: $0 <script.js> [script2.js ...]" >&2
    exit 1
fi

mkdir -p "$RESULT_DIR"

OVERALL_EXIT=0

for SCRIPT_REL in "$@"; do
    # 絶対パスに変換
    if [[ "$SCRIPT_REL" = /* ]]; then
        SCRIPT_ABS="$SCRIPT_REL"
    else
        SCRIPT_ABS="${PROJECT_ROOT}/${SCRIPT_REL}"
    fi

    if [ ! -f "$SCRIPT_ABS" ]; then
        echo "ERROR: スクリプトが見つかりません: $SCRIPT_ABS" >&2
        OVERALL_EXIT=1
        continue
    fi

    SCRIPT_NAME="$(basename "$SCRIPT_ABS" .js)"
    RESULT_FILE="${RESULT_DIR}/${SCRIPT_NAME}_result.json"
    LOG_FILE="${RESULT_DIR}/${SCRIPT_NAME}.log"

    echo "=== 実行: $SCRIPT_NAME ==="
    echo "  script: $SCRIPT_ABS"
    echo "  result: $RESULT_FILE"
    echo "  log:    $LOG_FILE"

    # PixInsight を automation-mode で実行
    "$PIXINSIGHT" \
        --automation-mode \
        -r="$SCRIPT_ABS" \
        --force-exit \
        2>&1 || true

    # hello_automation.js のような結果JSONを持たないスクリプトはスキップ
    if [ ! -f "$RESULT_FILE" ]; then
        echo "  NOTE: 結果JSONが見つかりません。スキップします: $RESULT_FILE"
        echo "==================================="
        continue
    fi

    # 結果JSONを読み取り
    FAILED=$(python3 -c "import json,sys; d=json.load(open('$RESULT_FILE')); print(d.get('failed', 0))" 2>/dev/null || echo "parse_error")

    if [ "$FAILED" = "parse_error" ]; then
        echo "  ERROR: 結果JSONのパースに失敗しました"
        OVERALL_EXIT=1
    elif [ "$FAILED" = "0" ]; then
        echo "  RESULT: PASS (failed=0)"
    else
        echo "  RESULT: FAIL (failed=$FAILED)"
        python3 -c "
import json, sys
d = json.load(open('$RESULT_FILE'))
for e in d.get('errors', []):
    print('  FAIL: ' + e.get('name','?'))
    print('    ' + e.get('error','?'))
" 2>/dev/null || true
        OVERALL_EXIT=1
    fi

    # ログファイルが存在すれば内容を表示
    if [ -f "$LOG_FILE" ]; then
        echo ""
        echo "--- Console Log ($SCRIPT_NAME) ---"
        cat "$LOG_FILE"
        echo "--- End Log ---"
    fi
    echo "==================================="
done

exit $OVERALL_EXIT
