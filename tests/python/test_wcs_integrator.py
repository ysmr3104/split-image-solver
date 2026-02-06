"""
WCS統合モジュールのテスト
"""

import pytest
import numpy as np
from astropy.wcs import WCS

# テストは今後実装
# 実際のWCSデータが必要なため、モックWCSを使用する

def test_transform_split_wcs_to_full_image():
    """WCS座標変換のテスト"""
    # モックWCSを作成
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [500, 500]
    wcs.wcs.crval = [180.0, 45.0]
    wcs.wcs.cd = np.array([[-0.0001, 0.0], [0.0, 0.0001]])
    wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']

    from wcs_integrator import WCSIntegrator

    # ダミーのデータで WCSIntegrator をインスタンス化
    integrator = WCSIntegrator(
        original_image_shape=(2000, 2000),
        split_regions_info=[],
        split_wcs_list=[],
        solve_results=[]
    )

    # オフセット (100, 200) で変換
    transformed_wcs = integrator.transform_split_wcs_to_full_image(wcs, 100, 200)

    # CRPIX がオフセット分調整されているか確認
    assert transformed_wcs.wcs.crpix[0] == wcs.wcs.crpix[0] + 100
    assert transformed_wcs.wcs.crpix[1] == wcs.wcs.crpix[1] + 200

    # CD matrix は変更されていないか確認
    np.testing.assert_array_equal(transformed_wcs.wcs.cd, wcs.wcs.cd)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
