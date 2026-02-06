.PHONY: help setup install install-xisf test test-unit test-integration test-coverage lint format clean run-example check-astap

# 変数定義
VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
PYTEST := $(VENV)/bin/pytest
BLACK := $(VENV)/bin/black
FLAKE8 := $(VENV)/bin/flake8

# デフォルトターゲット
.DEFAULT_GOAL := help

help: ## このヘルプメッセージを表示
	@echo "Split Image Solver - 利用可能なコマンド:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36mmake %-25s\033[0m %s\n", $$1, $$2}'

# ========================================
# セットアップコマンド
# ========================================

setup: ## 仮想環境をセットアップ
	@echo "🔧 仮想環境をセットアップしています..."
	@if [ -d "$(VENV)" ]; then \
		echo "既存の仮想環境を削除しています..."; \
		rm -rf $(VENV); \
	fi
	@python3 -m venv $(VENV)
	@$(PIP) install --upgrade pip
	@echo "✅ 仮想環境のセットアップ完了"
	@echo "次のコマンド: make install"

install: ## 依存関係をインストール
	@echo "📦 依存関係をインストールしています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		echo "先に 'make setup' を実行してください"; \
		exit 1; \
	fi
	@$(PIP) install -r requirements.txt
	@echo "✅ 依存関係のインストール完了"
	@echo ""
	@echo "📋 インストールされたパッケージ:"
	@$(PIP) list | grep -E '(numpy|astropy|scipy|xisf|lxml|pytest)'

install-dev: setup install ## 開発環境をセットアップ（setup + install）
	@echo "✅ 開発環境のセットアップが完了しました"
	@echo ""
	@echo "📝 次のステップ:"
	@echo "  1. ASTAP をインストール: https://www.hnsky.org/astap.htm"
	@echo "  2. 設定ファイルを作成: cp config/settings.example.json config/settings.json"
	@echo "  3. config/settings.json を編集してASTAPのパスを設定"
	@echo "  4. make check-astap でASTAPが使用可能か確認"

install-xisf: ## XISF関連ライブラリのみをインストール
	@echo "📦 XISF関連ライブラリをインストールしています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		echo "先に 'make setup' を実行してください"; \
		exit 1; \
	fi
	@$(PIP) install xisf lxml
	@echo "✅ XISF関連ライブラリのインストール完了"

check-astap: ## ASTAPのインストール状況を確認
	@echo "🔍 ASTAPのインストール状況を確認しています..."
	@if command -v astap &> /dev/null; then \
		echo "✅ ASTAP が見つかりました:"; \
		which astap; \
		astap -v 2>&1 | head -1 || echo "バージョン情報なし"; \
	else \
		echo "❌ ASTAP が見つかりません"; \
		echo ""; \
		echo "インストール方法:"; \
		echo "  1. https://www.hnsky.org/astap.htm からダウンロード"; \
		echo "  2. 星データベースもダウンロードして配置"; \
		echo "  3. config/settings.json にパスを設定"; \
	fi

# ========================================
# テストコマンド
# ========================================

test-unit: ## ユニットテストを実行
	@echo "🧪 ユニットテストを実行しています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		echo "先に 'make install-dev' を実行してください"; \
		exit 1; \
	fi
	@PYTHONPATH="." $(PYTEST) tests/python -v

test-coverage: ## テストカバレッジレポートを生成
	@echo "📊 テストカバレッジレポートを生成しています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		exit 1; \
	fi
	@PYTHONPATH="." $(PYTEST) tests/python --cov=python --cov-report=term-missing --cov-report=html
	@echo "✅ カバレッジレポートを生成しました: htmlcov/index.html"

test: test-unit ## すべてのテストを実行
	@echo "✅ すべてのテスト完了"

# ========================================
# コード品質コマンド
# ========================================

format: ## コードを自動フォーマット（Black）
	@echo "🎨 コードをフォーマットしています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		exit 1; \
	fi
	@$(BLACK) python/ tests/ 2>/dev/null || echo "一部のディレクトリが見つかりませんでした"
	@echo "✅ フォーマット完了"

lint: ## リンティングチェックを実行
	@echo "🔍 リンティングチェックを実行しています..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		exit 1; \
	fi
	@$(BLACK) --check --diff python/ tests/ 2>/dev/null || echo "⚠️ フォーマット修正が必要です"
	@echo "✅ リンティングチェック完了"

# ========================================
# 実行コマンド
# ========================================

run-example: ## サンプル画像で実行（テスト用）
	@echo "🚀 サンプル実行..."
	@if [ ! -d "$(VENV)" ]; then \
		echo "❌ エラー: 仮想環境が見つかりません"; \
		echo "先に 'make install-dev' を実行してください"; \
		exit 1; \
	fi
	@if [ ! -f "config/settings.json" ]; then \
		echo "❌ エラー: config/settings.json が見つかりません"; \
		echo "設定ファイルを作成してください:"; \
		echo "  cp config/settings.example.json config/settings.json"; \
		exit 1; \
	fi
	@echo "使用方法:"
	@echo "  $(PYTHON) python/main.py --input your_image.fits --output solved.fits --grid 2x2"
	@echo ""
	@echo "XISF形式の場合:"
	@echo "  $(PYTHON) python/main.py --input your_image.xisf --output solved.xisf --grid 2x2"

run: ## ヘルプを表示（実際の実行は手動で行う）
	@$(PYTHON) python/main.py --help

# ========================================
# クリーンアップコマンド
# ========================================

clean: ## 仮想環境とキャッシュをクリーンアップ
	@echo "🧹 クリーンアップしています..."
	@rm -rf $(VENV)
	@find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name htmlcov -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@find . -type f -name ".coverage" -delete 2>/dev/null || true
	@rm -rf .server.log .server.pid 2>/dev/null || true
	@echo "✅ クリーンアップ完了"

clean-temp: ## 一時ファイルのみをクリーンアップ
	@echo "🧹 一時ファイルをクリーンアップしています..."
	@find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@echo "✅ 一時ファイルのクリーンアップ完了"

# ========================================
# 情報表示コマンド
# ========================================

info: ## プロジェクト情報を表示
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📦 Split Image Solver"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "🎯 目的:"
	@echo "  PixInsightで対応できない広角星空画像を分割してプレートソルブ"
	@echo ""
	@echo "✨ 主な機能:"
	@echo "  - FITS/XISF両形式対応"
	@echo "  - 柔軟な分割パターン（2x2, 3x3, 2x4など）"
	@echo "  - ASTAP並列処理"
	@echo "  - WCS座標統合"
	@echo ""
	@echo "📂 プロジェクト構造:"
	@if [ -d "$(VENV)" ]; then \
		echo "  ✅ 仮想環境: $(VENV)"; \
	else \
		echo "  ❌ 仮想環境: 未作成"; \
	fi
	@if [ -f "config/settings.json" ]; then \
		echo "  ✅ 設定ファイル: config/settings.json"; \
	else \
		echo "  ❌ 設定ファイル: 未作成"; \
	fi
	@if command -v astap &> /dev/null; then \
		echo "  ✅ ASTAP: インストール済み"; \
	else \
		echo "  ❌ ASTAP: 未インストール"; \
	fi
	@echo ""
	@echo "📚 ドキュメント: README.md"
	@echo "🐛 問題報告: GitHub Issues"
	@echo ""

status: info ## プロジェクトの状態を表示（infoのエイリアス）
