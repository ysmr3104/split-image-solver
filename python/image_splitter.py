"""
画像分割モジュール
星空画像を指定されたグリッドパターンで分割する
"""

import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple
from astropy.io import fits
from astropy.nddata import CCDData
import astropy.units as u

from utils.logger import get_logger

logger = get_logger()


class ImageSplitter:
    """
    画像を指定されたグリッドパターンで分割

    Attributes:
        image_data: numpy array (H, W) or (H, W, C)
        grid_pattern: str "NxM" 形式
        overlap_pixels: int オーバーラップピクセル数
        original_shape: Tuple[int, int] 元画像のサイズ (height, width)
    """

    def __init__(
        self,
        image_data: np.ndarray,
        header: fits.Header,
        grid_pattern: str,
        overlap_pixels: int = 100,
        input_format: str = 'fits',
        original_metadata: dict = None
    ):
        """
        Args:
            image_data: numpy array (H, W) or (H, W, C)
            header: FITS header from original image
            grid_pattern: str "NxM" 形式 (例: "2x2", "3x3", "2x4")
            overlap_pixels: int オーバーラップピクセル数
            input_format: str 入力ファイル形式 ('fits' or 'xisf')
            original_metadata: dict 元画像のメタデータ（XISF用）
        """
        self.image_data = image_data
        self.original_header = header
        self.grid_pattern = grid_pattern
        self.overlap_pixels = overlap_pixels
        self.input_format = input_format.lower()
        self.original_metadata = original_metadata or {}

        # 画像サイズ
        if image_data.ndim == 2:
            self.height, self.width = image_data.shape
            self.channels = 1
        elif image_data.ndim == 3:
            self.height, self.width, self.channels = image_data.shape
        else:
            raise ValueError(f"Unsupported image dimensions: {image_data.ndim}")

        self.original_shape = (self.height, self.width)

        # グリッドパターンを解析
        self.rows, self.cols = self._parse_grid_pattern(grid_pattern)

        logger.info(
            f"ImageSplitter initialized: image={self.width}x{self.height}, "
            f"grid={self.rows}x{self.cols}, overlap={overlap_pixels}px"
        )

    def _parse_grid_pattern(self, pattern: str) -> Tuple[int, int]:
        """
        グリッドパターンを解析

        Args:
            pattern: "NxM" 形式の文字列

        Returns:
            Tuple[int, int]: (rows, cols)
        """
        try:
            parts = pattern.lower().split('x')
            if len(parts) != 2:
                raise ValueError

            rows = int(parts[0])
            cols = int(parts[1])

            if rows < 1 or cols < 1:
                raise ValueError

            return rows, cols

        except (ValueError, AttributeError):
            raise ValueError(
                f"Invalid grid pattern: '{pattern}'. "
                "Expected format: 'NxM' (e.g., '2x2', '3x3')"
            )

    def calculate_split_regions(self) -> List[Dict]:
        """
        分割領域を計算

        Returns:
            List[Dict]: 各分割領域の情報
                {
                    'index': (row, col),
                    'x_start': int,
                    'y_start': int,
                    'x_end': int,
                    'y_end': int,
                    'width': int,
                    'height': int,
                    'center_x': float,  # 元画像内での中心X座標
                    'center_y': float,  # 元画像内での中心Y座標
                }
        """
        regions = []

        # 基本タイルサイズ（オーバーラップなし）
        base_tile_width = self.width // self.cols
        base_tile_height = self.height // self.rows

        logger.debug(f"Base tile size: {base_tile_width}x{base_tile_height}")

        for row in range(self.rows):
            for col in range(self.cols):
                # 開始位置（オーバーラップなし）
                x_start_base = col * base_tile_width
                y_start_base = row * base_tile_height

                # オーバーラップを考慮した開始位置
                x_start = max(0, x_start_base - self.overlap_pixels)
                y_start = max(0, y_start_base - self.overlap_pixels)

                # 終了位置（オーバーラップなし）
                x_end_base = x_start_base + base_tile_width
                y_end_base = y_start_base + base_tile_height

                # 最後の行/列は画像の端まで
                if col == self.cols - 1:
                    x_end_base = self.width
                if row == self.rows - 1:
                    y_end_base = self.height

                # オーバーラップを考慮した終了位置
                x_end = min(self.width, x_end_base + self.overlap_pixels)
                y_end = min(self.height, y_end_base + self.overlap_pixels)

                # タイルサイズ
                tile_width = x_end - x_start
                tile_height = y_end - y_start

                # 中心座標（元画像座標系）
                center_x = x_start + tile_width / 2.0
                center_y = y_start + tile_height / 2.0

                region = {
                    'index': (row, col),
                    'x_start': x_start,
                    'y_start': y_start,
                    'x_end': x_end,
                    'y_end': y_end,
                    'width': tile_width,
                    'height': tile_height,
                    'center_x': center_x,
                    'center_y': center_y,
                }

                regions.append(region)

                logger.debug(
                    f"Region [{row},{col}]: "
                    f"x={x_start}:{x_end}, y={y_start}:{y_end}, "
                    f"size={tile_width}x{tile_height}"
                )

        return regions

    def split_and_save(self, output_dir: Path) -> List[Dict]:
        """
        画像を分割して保存（XISF形式の場合はXISF、FITS形式の場合はFITS）

        Args:
            output_dir: 出力ディレクトリ

        Returns:
            List[Dict]: 保存された各ファイルの情報
                {
                    'file_path': Path,
                    'region': Dict (calculate_split_regions()の返り値),
                }
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        regions = self.calculate_split_regions()
        saved_files = []

        logger.info(f"Splitting image into {len(regions)} tiles (format: {self.input_format.upper()})...")

        for region in regions:
            row, col = region['index']
            x_start = region['x_start']
            y_start = region['y_start']
            x_end = region['x_end']
            y_end = region['y_end']

            # 画像データを切り出し
            if self.image_data.ndim == 2:
                tile_data = self.image_data[y_start:y_end, x_start:x_end]
            else:
                tile_data = self.image_data[y_start:y_end, x_start:x_end, :]

            # XISF形式の場合とFITS形式の場合で処理を分岐
            if self.input_format == 'xisf':
                # XISF形式: RGBのまま保存
                filename = f"tile_{row:02d}_{col:02d}.xisf"
                file_path = output_dir / filename

                try:
                    from xisf_handler import XISFHandler

                    # メタデータに分割情報を追加
                    tile_metadata = self.original_metadata.copy() if self.original_metadata else {}

                    # FITSキーワードに分割情報を追加
                    if 'fits_keywords' not in tile_metadata:
                        tile_metadata['fits_keywords'] = {}

                    tile_metadata['fits_keywords'].update({
                        'ORIGSIZX': self.width,
                        'ORIGSIZY': self.height,
                        'SPLITX': col,
                        'SPLITY': row,
                        'OFFSETX': x_start,
                        'OFFSETY': y_start,
                        'OVERLAP': self.overlap_pixels,
                        'GRIDCOLS': self.cols,
                        'GRIDROWS': self.rows,
                    })

                    # WCS情報を削除
                    wcs_keywords = [
                        'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2',
                        'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2',
                        'CDELT1', 'CDELT2', 'CROTA1', 'CROTA2',
                        'CTYPE1', 'CTYPE2', 'CUNIT1', 'CUNIT2',
                        'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2',
                        'RADESYS', 'EQUINOX', 'PLTSOLVD'
                    ]
                    for keyword in wcs_keywords:
                        tile_metadata['fits_keywords'].pop(keyword, None)

                    # XISF形式で保存（RGBのまま）
                    XISFHandler.save_image(
                        file_path=file_path,
                        image_data=tile_data,
                        metadata=tile_metadata
                    )

                    logger.info(f"Saved XISF tile [{row},{col}]: {file_path}")

                except ImportError as e:
                    logger.error(f"XISF support not available: {e}")
                    raise

            else:
                # FITS形式: 既存の処理（モノクロ変換）
                # 1. RGB画像の場合はグレースケールに変換
                if tile_data.ndim == 3:
                    # 輝度チャンネル（緑チャンネル）を使用、またはRGB平均
                    tile_data = tile_data[:, :, 1]  # Green channel (usually best for star detection)
                    logger.debug(f"Converted RGB to mono for tile [{row},{col}]")

                # 2. float型の場合は16ビット整数にスケーリング
                if tile_data.dtype in [np.float32, np.float64]:
                    # データ範囲を確認
                    data_min = np.min(tile_data)
                    data_max = np.max(tile_data)
                    logger.debug(f"Tile [{row},{col}] data range: {data_min:.6f} to {data_max:.6f}")

                    # 0-1範囲の場合は0-65535にスケーリング
                    if data_max <= 1.5:  # 正規化されたデータと判定
                        tile_data = np.clip(tile_data, 0, 1)
                        tile_data = (tile_data * 65535).astype(np.uint16)
                        logger.debug(f"Scaled float data to uint16 for tile [{row},{col}]")
                    else:
                        # そのまま整数化
                        tile_data = tile_data.astype(np.uint16)

                # FITSファイル名
                filename = f"tile_{row:02d}_{col:02d}.fits"
                file_path = output_dir / filename

                # FITSヘッダーを作成（元画像のヘッダーをコピー）
                header = self.original_header.copy()

                # 分割情報をヘッダーに追加
                header['ORIGSIZX'] = (self.width, 'Original image width')
                header['ORIGSIZY'] = (self.height, 'Original image height')
                header['SPLITX'] = (col, 'Split tile column index')
                header['SPLITY'] = (row, 'Split tile row index')
                header['OFFSETX'] = (x_start, 'X offset in original image')
                header['OFFSETY'] = (y_start, 'Y offset in original image')
                header['OVERLAP'] = (self.overlap_pixels, 'Overlap pixels')
                header['GRIDCOLS'] = (self.cols, 'Number of grid columns')
                header['GRIDROWS'] = (self.rows, 'Number of grid rows')

                # 画像サイズを更新
                header['NAXIS1'] = tile_data.shape[1] if tile_data.ndim >= 2 else 1
                header['NAXIS2'] = tile_data.shape[0]

                # WCS情報が存在する場合は削除（後でソルバーが新しく追加する）
                wcs_keywords = [
                    'CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2',
                    'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2',
                    'CDELT1', 'CDELT2', 'CROTA1', 'CROTA2',
                    'CTYPE1', 'CTYPE2', 'CUNIT1', 'CUNIT2',
                    'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2',
                    'RADESYS', 'EQUINOX'
                ]
                for keyword in wcs_keywords:
                    if keyword in header:
                        del header[keyword]

                # FITS ファイルとして保存
                hdu = fits.PrimaryHDU(data=tile_data, header=header)
                hdu.writeto(file_path, overwrite=True, output_verify='fix')

                logger.info(f"Saved FITS tile [{row},{col}]: {file_path}")

            saved_files.append({
                'file_path': file_path,
                'region': region,
            })

        logger.info(f"Image splitting completed: {len(saved_files)} tiles saved")

        return saved_files


def load_image(file_path: Path) -> Tuple[np.ndarray, fits.Header]:
    """
    FITS/XISF画像を読み込む

    ファイル形式を自動判定して適切なハンドラーを使用

    Args:
        file_path: FITS/XISFファイルパス

    Returns:
        Tuple[np.ndarray, fits.Header]: (画像データ, FITSヘッダー形式のメタデータ)
    """
    file_path = Path(file_path)

    if not file_path.exists():
        raise FileNotFoundError(f"Image file not found: {file_path}")

    logger.info(f"Loading image: {file_path}")

    # ファイル拡張子で形式を判定
    suffix = file_path.suffix.lower()

    if suffix in ['.xisf']:
        # XISF形式
        try:
            from xisf_handler import XISFHandler

            image_data, metadata = XISFHandler.load_image(file_path)

            # XISFメタデータをFITSヘッダーに変換
            header = XISFHandler.convert_to_fits_header(metadata)

            # データ型を float64 に変換
            image_data = image_data.astype(np.float64)

            logger.info(
                f"XISF image loaded: shape={image_data.shape}, "
                f"dtype={image_data.dtype}"
            )

            return image_data, header

        except ImportError as e:
            logger.error(f"XISF support not available: {e}")
            logger.error("Please install: pip install xisf lxml")
            raise

    elif suffix in ['.fits', '.fit', '.fts']:
        # FITS形式
        with fits.open(file_path) as hdul:
            # メイン画像データを取得
            image_data = hdul[0].data
            header = hdul[0].header

            if image_data is None:
                raise ValueError(f"No image data found in FITS file: {file_path}")

            # データ型を float64 に変換
            image_data = image_data.astype(np.float64)

            logger.info(
                f"FITS image loaded: shape={image_data.shape}, "
                f"dtype={image_data.dtype}"
            )

        return image_data, header

    else:
        raise ValueError(
            f"Unsupported file format: {suffix}. "
            "Supported formats: .fits, .fit, .fts, .xisf"
        )
