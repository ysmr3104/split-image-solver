"""
FITSファイルハンドラーモジュール
FITS画像の読み書きとWCSヘッダーの更新
"""

import shutil
from pathlib import Path
from typing import Optional
from astropy.io import fits
from astropy.wcs import WCS
from datetime import datetime

from utils.logger import get_logger

logger = get_logger()


class FITSHandler:
    """
    FITSファイルの読み書きとヘッダー操作
    """

    @staticmethod
    def write_wcs_to_header(
        input_path: Path,
        wcs: WCS,
        output_path: Optional[Path] = None,
        include_history: bool = True
    ) -> Path:
        """
        WCS情報をFITSヘッダーに書き込み

        書き込むキーワード:
        - CRVAL1, CRVAL2: 参照点の天球座標
        - CRPIX1, CRPIX2: 参照点のピクセル座標
        - CD1_1, CD1_2, CD2_1, CD2_2: スケール+回転行列
        - CTYPE1, CTYPE2: 座標系タイプ (RA---TAN, DEC--TAN など)
        - CUNIT1, CUNIT2: 単位 (deg)
        - RADESYS: 天球座標系 (ICRS, FK5 など)
        - EQUINOX: 分点 (2000.0)

        Args:
            input_path: 入力FITSパス
            wcs: astropy.wcs.WCS オブジェクト
            output_path: 出力パス (Noneの場合は上書き)
            include_history: HISTORYキーワードを追加するか

        Returns:
            Path: 出力ファイルパス
        """
        input_path = Path(input_path)
        logger.info(f"Writing WCS to FITS header: {input_path}")

        if not input_path.exists():
            raise FileNotFoundError(f"Input FITS file not found: {input_path}")

        # 出力パスが指定されていない場合は上書き
        if output_path is None:
            output_path = input_path
        else:
            output_path = Path(output_path)
            # 入力ファイルをコピー
            if input_path != output_path:
                shutil.copy(input_path, output_path)

        # FITSファイルを開く
        with fits.open(output_path, mode='update') as hdul:
            header = hdul[0].header

            # WCSキーワードを設定
            # CRVAL: 参照点の天球座標
            header['CRVAL1'] = (wcs.wcs.crval[0], 'RA at reference point (degrees)')
            header['CRVAL2'] = (wcs.wcs.crval[1], 'Dec at reference point (degrees)')

            # CRPIX: 参照点のピクセル座標 (1-based)
            header['CRPIX1'] = (wcs.wcs.crpix[0], 'Reference pixel X')
            header['CRPIX2'] = (wcs.wcs.crpix[1], 'Reference pixel Y')

            # CD matrix: スケール+回転
            if wcs.wcs.cd is not None and wcs.wcs.cd.size > 0:
                header['CD1_1'] = (wcs.wcs.cd[0, 0], 'CD matrix element (1,1)')
                header['CD1_2'] = (wcs.wcs.cd[0, 1], 'CD matrix element (1,2)')
                header['CD2_1'] = (wcs.wcs.cd[1, 0], 'CD matrix element (2,1)')
                header['CD2_2'] = (wcs.wcs.cd[1, 1], 'CD matrix element (2,2)')

            # CTYPE: 座標系タイプ
            header['CTYPE1'] = (wcs.wcs.ctype[0], 'Coordinate type for axis 1')
            header['CTYPE2'] = (wcs.wcs.ctype[1], 'Coordinate type for axis 2')

            # CUNIT: 単位
            header['CUNIT1'] = ('deg', 'Unit for axis 1')
            header['CUNIT2'] = ('deg', 'Unit for axis 2')

            # RADESYS: 座標系
            if hasattr(wcs.wcs, 'radesys') and wcs.wcs.radesys:
                header['RADESYS'] = (wcs.wcs.radesys, 'Coordinate reference frame')
            else:
                header['RADESYS'] = ('ICRS', 'Coordinate reference frame')

            # EQUINOX: 分点
            if hasattr(wcs.wcs, 'equinox') and wcs.wcs.equinox:
                header['EQUINOX'] = (wcs.wcs.equinox, 'Equinox of coordinates')
            else:
                header['EQUINOX'] = (2000.0, 'Equinox of coordinates')

            # HISTORY記録
            if include_history:
                timestamp = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
                header['HISTORY'] = f'WCS solution added by Split Image Solver at {timestamp}'
                header['HISTORY'] = 'Image was split into tiles, solved with ASTAP, and integrated'

            # プレートソルブ済みフラグ
            header['PLTSOLVD'] = (True, 'Plate solved by Split Image Solver')

            logger.info(f"WCS written successfully to: {output_path}")

        return output_path

    @staticmethod
    def read_wcs_from_header(fits_path: Path) -> Optional[WCS]:
        """
        FITSヘッダーからWCS情報を読み取る

        Args:
            fits_path: FITSファイルパス

        Returns:
            Optional[WCS]: WCSオブジェクト（存在しない場合はNone）
        """
        fits_path = Path(fits_path)
        logger.debug(f"Reading WCS from FITS header: {fits_path}")

        if not fits_path.exists():
            raise FileNotFoundError(f"FITS file not found: {fits_path}")

        try:
            with fits.open(fits_path) as hdul:
                header = hdul[0].header
                wcs = WCS(header)

                if wcs.has_celestial:
                    logger.debug(f"WCS found in {fits_path}")
                    return wcs
                else:
                    logger.debug(f"No valid WCS in {fits_path}")
                    return None

        except Exception as e:
            logger.warning(f"Failed to read WCS from {fits_path}: {e}")
            return None

    @staticmethod
    def copy_with_wcs(
        input_path: Path,
        output_path: Path,
        wcs: WCS
    ) -> Path:
        """
        FITSファイルをコピーしてWCS情報を追加

        Args:
            input_path: 入力FITSパス
            output_path: 出力FITSパス
            wcs: 追加するWCS

        Returns:
            Path: 出力ファイルパス
        """
        input_path = Path(input_path)
        output_path = Path(output_path)

        logger.info(f"Copying FITS with WCS: {input_path} -> {output_path}")

        # コピー
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(input_path, output_path)

        # WCS書き込み
        return FITSHandler.write_wcs_to_header(output_path, wcs)
