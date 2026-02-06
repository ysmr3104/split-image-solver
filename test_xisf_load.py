#!/usr/bin/env python3
import sys
sys.path.insert(0, 'python')

from xisf_handler import XISFHandler
from pathlib import Path

# XISFファイルを読み込んでみる
xisf_path = Path("/Users/yossy/Downloads/masterLight_BIN-1_6024x4024_EXPOSURE-181.00s_FILTER-NoFilter_RGB.xisf")

if not xisf_path.exists():
    print(f"❌ ファイルが見つかりません: {xisf_path}")
    sys.exit(1)

print(f"📂 XISFファイルを読み込んでいます...")
print(f"   {xisf_path.name}")
print()

try:
    image_data, metadata = XISFHandler.load_image(xisf_path)
    
    print("✅ XISFファイルの読み込みに成功しました！")
    print()
    print(f"📊 画像情報:")
    print(f"   サイズ: {image_data.shape}")
    print(f"   データ型: {image_data.dtype}")
    print(f"   最小値: {image_data.min():.6f}")
    print(f"   最大値: {image_data.max():.6f}")
    print()
    
    fits_keywords = metadata.get('fits_keywords', {})
    if fits_keywords:
        print(f"📋 FITSキーワード数: {len(fits_keywords)}")
        print("   主要なキーワード:")
        for key in ['EXPOSURE', 'FILTER', 'INSTRUME', 'TELESCOP']:
            if key in fits_keywords:
                print(f"   - {key}: {fits_keywords[key]}")
    
    print()
    print("✨ XISF形式のサポートは正常に動作しています！")
    print()
    print("次のステップ:")
    print("  1. ASTAPをインストール: https://www.hnsky.org/astap.htm")
    print("  2. 実際のプレートソルブを実行")
    
except Exception as e:
    print(f"❌ エラーが発生しました: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
