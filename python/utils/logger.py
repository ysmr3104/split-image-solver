"""
ログ機構
アプリケーション全体で使用する統一的なロギングシステム
"""

import logging
import sys
from pathlib import Path
from typing import Optional


def setup_logger(
    name: str = "split_image_solver",
    level: str = "INFO",
    log_file: Optional[str] = None,
    console_output: bool = True,
    use_stderr: bool = False
) -> logging.Logger:
    """
    ロガーをセットアップ

    Args:
        name: ロガー名
        level: ログレベル (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: ログファイルパス (Noneの場合はファイル出力なし)
        console_output: コンソール出力を有効にするか
        use_stderr: Trueの場合、コンソール出力をstderrに送る（--json-output用）

    Returns:
        logging.Logger: 設定されたロガー
    """
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper()))

    # 既存のハンドラーをクリア
    logger.handlers.clear()

    # フォーマッター
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # コンソールハンドラー
    if console_output:
        console_handler = logging.StreamHandler(sys.stderr if use_stderr else sys.stdout)
        console_handler.setLevel(getattr(logging, level.upper()))
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

    # ファイルハンドラー
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
        file_handler.setLevel(getattr(logging, level.upper()))
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger


def get_logger(name: str = "split_image_solver") -> logging.Logger:
    """
    既存のロガーを取得

    Args:
        name: ロガー名

    Returns:
        logging.Logger: ロガー
    """
    return logging.getLogger(name)
