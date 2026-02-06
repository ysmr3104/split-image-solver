"""
画像分割モジュールのテスト
"""

import pytest
import numpy as np
from astropy.io import fits

# テストは今後実装
# 実際の画像データが必要なため、モック画像を使用する

def test_grid_pattern_parsing():
    """グリッドパターンの解析テスト"""
    from image_splitter import ImageSplitter

    # モック画像データ
    image_data = np.random.rand(1000, 1000)
    header = fits.Header()

    splitter = ImageSplitter(image_data, header, "2x2", overlap_pixels=50)
    assert splitter.rows == 2
    assert splitter.cols == 2

    splitter = ImageSplitter(image_data, header, "3x3", overlap_pixels=100)
    assert splitter.rows == 3
    assert splitter.cols == 3


def test_split_regions_calculation():
    """分割領域計算のテスト"""
    from image_splitter import ImageSplitter

    # モック画像データ
    image_data = np.random.rand(1000, 1000)
    header = fits.Header()

    splitter = ImageSplitter(image_data, header, "2x2", overlap_pixels=50)
    regions = splitter.calculate_split_regions()

    # 2x2なので4つの領域
    assert len(regions) == 4

    # 各領域の基本チェック
    for region in regions:
        assert 'x_start' in region
        assert 'y_start' in region
        assert 'x_end' in region
        assert 'y_end' in region
        assert region['x_end'] > region['x_start']
        assert region['y_end'] > region['y_start']


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
