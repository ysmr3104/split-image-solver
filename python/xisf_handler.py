"""
XISFファイルハンドラーモジュール
XISF（Extensible Image Serialization Format）の読み書きとメタデータ処理
PixInsightのネイティブ形式に完全対応
"""

import numpy as np
from pathlib import Path
from typing import Dict, Optional, Tuple
from astropy.io import fits
from astropy.wcs import WCS
import xisf
from lxml import etree

from utils.logger import get_logger

logger = get_logger()


class XISFHandler:
    """
    XISFファイルの読み書きとメタデータ操作
    """

    @staticmethod
    def load_image(file_path: Path) -> Tuple[np.ndarray, Dict]:
        """
        XISF画像を読み込む

        Args:
            file_path: XISFファイルパス

        Returns:
            Tuple[np.ndarray, Dict]: (画像データ, メタデータ辞書)
        """
        file_path = Path(file_path)

        if not file_path.exists():
            raise FileNotFoundError(f"XISF file not found: {file_path}")

        logger.info(f"Loading XISF image: {file_path}")

        try:
            # XISFファイルを読み込み
            xisf_file = xisf.XISF(str(file_path))

            # 画像データを取得（最初の画像）
            image_data = xisf_file.read_image(0)

            # メタデータを取得
            metadata = xisf_file.get_images_metadata()[0]

            # ファイルヘッダーのメタデータも取得
            file_metadata = xisf_file.get_file_metadata()

            # 統合したメタデータ辞書を作成
            combined_metadata = {
                'image_metadata': metadata,
                'file_metadata': file_metadata,
            }

            # FITSキーワードが存在する場合は抽出
            fits_keywords = {}
            if 'FITSKeywords' in metadata:
                fits_keywords = XISFHandler._parse_fits_keywords(metadata['FITSKeywords'])

            combined_metadata['fits_keywords'] = fits_keywords

            logger.info(
                f"XISF loaded: shape={image_data.shape}, "
                f"dtype={image_data.dtype}, "
                f"fits_keywords={len(fits_keywords)}"
            )

            return image_data, combined_metadata

        except Exception as e:
            logger.error(f"Failed to load XISF: {e}")
            raise

    @staticmethod
    def save_image(
        file_path: Path,
        image_data: np.ndarray,
        metadata: Optional[Dict] = None,
        wcs: Optional[WCS] = None,
        creator_app: str = "Split Image Solver",
        compression: Optional[str] = None
    ) -> Path:
        """
        XISF画像を保存

        Args:
            file_path: 出力XISFファイルパス
            image_data: numpy array 画像データ
            metadata: メタデータ辞書（オプション）
            wcs: WCS情報（オプション）
            creator_app: 作成アプリケーション名
            compression: 圧縮形式 (None, 'lz4', 'lz4hc', 'zlib')

        Returns:
            Path: 出力ファイルパス
        """
        file_path = Path(file_path)
        logger.info(f"Saving XISF image: {file_path}")

        file_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            # 画像メタデータを準備
            im_metadata = {}

            if metadata:
                # 既存のメタデータをコピー
                if 'image_metadata' in metadata:
                    im_metadata.update(metadata['image_metadata'])

            # FITSキーワードを準備
            fits_keywords = {}
            if metadata and 'fits_keywords' in metadata:
                fits_keywords.update(metadata['fits_keywords'])

            # WCS情報をFITSキーワードとして追加
            if wcs:
                wcs_keywords = XISFHandler._wcs_to_fits_keywords(wcs)
                fits_keywords.update(wcs_keywords)

            # FITSキーワードをxisfライブラリが期待する形式に変換
            if fits_keywords:
                im_metadata['FITSKeywords'] = XISFHandler._format_fits_keywords_for_xisf(fits_keywords)

            # クリエーター情報を追加
            if 'CreatorApplication' not in im_metadata:
                im_metadata['CreatorApplication'] = creator_app

            # 圧縮設定
            compression_codec = None
            if compression:
                compression_codec = compression

            # 画像を書き込み（XISF.writeを使用）
            xisf.XISF.write(
                str(file_path),
                image_data,
                creator_app=creator_app,
                image_metadata=im_metadata,
                xisf_metadata=metadata.get('file_metadata', {}) if metadata else {},
                codec=compression_codec
            )

            logger.info(f"XISF saved successfully: {file_path}")

            return file_path

        except Exception as e:
            logger.error(f"Failed to save XISF: {e}")
            raise

    @staticmethod
    def write_wcs_to_metadata(
        file_path: Path,
        wcs: WCS,
        output_path: Optional[Path] = None
    ) -> Path:
        """
        既存のXISFファイルにWCS情報を追加

        Args:
            file_path: 入力XISFファイルパス
            wcs: WCS情報
            output_path: 出力パス（Noneの場合は上書き）

        Returns:
            Path: 出力ファイルパス
        """
        file_path = Path(file_path)
        logger.info(f"Writing WCS to XISF metadata: {file_path}")

        if not file_path.exists():
            raise FileNotFoundError(f"XISF file not found: {file_path}")

        # 画像とメタデータを読み込み
        image_data, metadata = XISFHandler.load_image(file_path)

        # 出力パスを決定
        if output_path is None:
            output_path = file_path
        else:
            output_path = Path(output_path)

        # WCS情報を追加して保存
        return XISFHandler.save_image(
            file_path=output_path,
            image_data=image_data,
            metadata=metadata,
            wcs=wcs
        )

    @staticmethod
    def read_wcs_from_metadata(file_path: Path) -> Optional[WCS]:
        """
        XISFメタデータからWCS情報を読み取る

        Args:
            file_path: XISFファイルパス

        Returns:
            Optional[WCS]: WCSオブジェクト（存在しない場合はNone）
        """
        file_path = Path(file_path)
        logger.debug(f"Reading WCS from XISF metadata: {file_path}")

        try:
            _, metadata = XISFHandler.load_image(file_path)

            fits_keywords = metadata.get('fits_keywords', {})

            if not fits_keywords:
                logger.debug(f"No FITS keywords in {file_path}")
                return None

            # FITSキーワードからWCSを構築
            wcs = XISFHandler._fits_keywords_to_wcs(fits_keywords)

            if wcs and wcs.has_celestial:
                logger.debug(f"WCS found in {file_path}")
                return wcs
            else:
                logger.debug(f"No valid WCS in {file_path}")
                return None

        except Exception as e:
            logger.warning(f"Failed to read WCS from {file_path}: {e}")
            return None

    @staticmethod
    def _parse_fits_keywords(fits_keywords_xml) -> Dict:
        """
        XISFのFITSKeywords形式からPython辞書に変換
        """
        keywords = {}

        # XMLパース（文字列の場合）
        if isinstance(fits_keywords_xml, str):
            try:
                root = etree.fromstring(fits_keywords_xml)
                for keyword in root.findall('.//FITSKeyword'):
                    name = keyword.get('name')
                    value = keyword.get('value')
                    comment = keyword.get('comment', '')

                    if name and value:
                        # 型変換を試みる
                        try:
                            # 数値変換
                            if '.' in value or 'e' in value.lower():
                                keywords[name] = float(value)
                            else:
                                keywords[name] = int(value)
                        except ValueError:
                            # 文字列として保存
                            keywords[name] = value.strip("'\"")
            except Exception as e:
                logger.warning(f"Failed to parse FITS keywords XML: {e}")

        # 辞書形式の場合（xisfライブラリが返す形式）
        elif isinstance(fits_keywords_xml, dict):
            # xisfライブラリの形式 {'KEY': [{'value': 'xxx', 'comment': 'yyy'}]} を
            # 単純な形式 {'KEY': 'xxx'} に変換
            for name, value in fits_keywords_xml.items():
                if isinstance(value, list) and len(value) > 0:
                    if isinstance(value[0], dict) and 'value' in value[0]:
                        extracted_value = value[0]['value']
                        # 型変換を試みる
                        try:
                            if isinstance(extracted_value, str):
                                if '.' in extracted_value or 'e' in extracted_value.lower():
                                    keywords[name] = float(extracted_value)
                                else:
                                    try:
                                        keywords[name] = int(extracted_value)
                                    except ValueError:
                                        keywords[name] = extracted_value
                            else:
                                keywords[name] = extracted_value
                        except (ValueError, AttributeError):
                            keywords[name] = extracted_value
                    else:
                        keywords[name] = value
                else:
                    keywords[name] = value

        return keywords

    @staticmethod
    def _format_fits_keywords(fits_keywords: Dict) -> str:
        """
        Python辞書をXISFのFITSKeywords XML形式に変換
        """
        root = etree.Element("FITSKeywords")

        for name, value in fits_keywords.items():
            keyword_elem = etree.SubElement(root, "FITSKeyword")
            keyword_elem.set("name", str(name))
            keyword_elem.set("value", str(value))

            # コメントがあれば追加（今は空）
            keyword_elem.set("comment", "")

        return etree.tostring(root, encoding='unicode', pretty_print=True)

    @staticmethod
    def _format_fits_keywords_for_xisf(fits_keywords: Dict) -> Dict:
        """
        Python辞書（単純な値）をxisfライブラリが期待する形式に変換

        入力例: {'ORIGSIZX': 6024, 'FILTER': 'NoFilter'}
        出力例: {'ORIGSIZX': [{'value': '6024', 'comment': ''}],
                 'FILTER': [{'value': 'NoFilter', 'comment': ''}]}
        """
        formatted = {}

        for name, value in fits_keywords.items():
            # 既に正しい形式（list of dicts）の場合はそのまま使用
            if isinstance(value, list) and len(value) > 0 and isinstance(value[0], dict):
                formatted[name] = value
            else:
                # 単純な値の場合は変換
                formatted[name] = [{'value': str(value), 'comment': ''}]

        return formatted

    @staticmethod
    def _wcs_to_fits_keywords(wcs: WCS) -> Dict:
        """
        WCSオブジェクトをFITSキーワード辞書に変換
        """
        keywords = {}

        # CRVAL: 参照点の天球座標
        keywords['CRVAL1'] = float(wcs.wcs.crval[0])
        keywords['CRVAL2'] = float(wcs.wcs.crval[1])

        # CRPIX: 参照点のピクセル座標
        keywords['CRPIX1'] = float(wcs.wcs.crpix[0])
        keywords['CRPIX2'] = float(wcs.wcs.crpix[1])

        # CD matrix
        if wcs.wcs.cd is not None and wcs.wcs.cd.size > 0:
            keywords['CD1_1'] = float(wcs.wcs.cd[0, 0])
            keywords['CD1_2'] = float(wcs.wcs.cd[0, 1])
            keywords['CD2_1'] = float(wcs.wcs.cd[1, 0])
            keywords['CD2_2'] = float(wcs.wcs.cd[1, 1])

        # CTYPE: 座標系タイプ
        keywords['CTYPE1'] = str(wcs.wcs.ctype[0])
        keywords['CTYPE2'] = str(wcs.wcs.ctype[1])

        # CUNIT: 単位
        keywords['CUNIT1'] = 'deg'
        keywords['CUNIT2'] = 'deg'

        # RADESYS: 座標系
        if hasattr(wcs.wcs, 'radesys') and wcs.wcs.radesys:
            keywords['RADESYS'] = str(wcs.wcs.radesys)
        else:
            keywords['RADESYS'] = 'ICRS'

        # EQUINOX: 分点
        if hasattr(wcs.wcs, 'equinox') and wcs.wcs.equinox:
            keywords['EQUINOX'] = float(wcs.wcs.equinox)
        else:
            keywords['EQUINOX'] = 2000.0

        # SIP歪み補正係数
        if wcs.sip is not None:
            sip = wcs.sip
            if sip.a is not None:
                order = sip.a_order
                keywords['A_ORDER'] = int(order)
                for i in range(order + 1):
                    for j in range(order + 1 - i):
                        if i + j >= 2:  # SIPは2次以上
                            val = float(sip.a[i, j])
                            if val != 0.0:
                                keywords[f'A_{i}_{j}'] = val
            if sip.b is not None:
                order = sip.b_order
                keywords['B_ORDER'] = int(order)
                for i in range(order + 1):
                    for j in range(order + 1 - i):
                        if i + j >= 2:
                            val = float(sip.b[i, j])
                            if val != 0.0:
                                keywords[f'B_{i}_{j}'] = val
            if sip.ap is not None:
                order = sip.ap_order
                keywords['AP_ORDER'] = int(order)
                for i in range(order + 1):
                    for j in range(order + 1 - i):
                        val = float(sip.ap[i, j])
                        if val != 0.0:
                            keywords[f'AP_{i}_{j}'] = val
            if sip.bp is not None:
                order = sip.bp_order
                keywords['BP_ORDER'] = int(order)
                for i in range(order + 1):
                    for j in range(order + 1 - i):
                        val = float(sip.bp[i, j])
                        if val != 0.0:
                            keywords[f'BP_{i}_{j}'] = val

        # プレートソルブ済みフラグ
        keywords['PLTSOLVD'] = 'T'

        return keywords

    @staticmethod
    def _fits_keywords_to_wcs(fits_keywords: Dict) -> Optional[WCS]:
        """
        FITSキーワード辞書からWCSオブジェクトを構築（SIP歪み補正対応）
        """
        try:
            # 必須キーワードの確認
            required = ['CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2']
            if not all(k in fits_keywords for k in required):
                return None

            wcs = WCS(naxis=2)

            crpix = [
                float(fits_keywords['CRPIX1']),
                float(fits_keywords['CRPIX2'])
            ]
            wcs.wcs.crval = [
                float(fits_keywords['CRVAL1']),
                float(fits_keywords['CRVAL2'])
            ]
            wcs.wcs.crpix = crpix

            # CD matrix
            if all(k in fits_keywords for k in ['CD1_1', 'CD1_2', 'CD2_1', 'CD2_2']):
                wcs.wcs.cd = np.array([
                    [float(fits_keywords['CD1_1']), float(fits_keywords['CD1_2'])],
                    [float(fits_keywords['CD2_1']), float(fits_keywords['CD2_2'])]
                ])

            # CTYPE
            if 'CTYPE1' in fits_keywords and 'CTYPE2' in fits_keywords:
                wcs.wcs.ctype = [
                    str(fits_keywords['CTYPE1']),
                    str(fits_keywords['CTYPE2'])
                ]
            else:
                wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']

            # RADESYS
            if 'RADESYS' in fits_keywords:
                wcs.wcs.radesys = str(fits_keywords['RADESYS'])
            else:
                wcs.wcs.radesys = 'ICRS'

            # EQUINOX
            if 'EQUINOX' in fits_keywords:
                wcs.wcs.equinox = float(fits_keywords['EQUINOX'])
            else:
                wcs.wcs.equinox = 2000.0

            # SIP歪み補正係数の読み込み
            has_sip = ('A_ORDER' in fits_keywords and 'B_ORDER' in fits_keywords)
            if has_sip:
                from astropy.wcs import Sip

                a_order = int(fits_keywords['A_ORDER'])
                b_order = int(fits_keywords['B_ORDER'])
                sip_order = max(a_order, b_order)

                a = np.zeros((sip_order + 1, sip_order + 1))
                b = np.zeros((sip_order + 1, sip_order + 1))

                for i in range(sip_order + 1):
                    for j in range(sip_order + 1 - i):
                        if i + j >= 2:
                            key_a = f'A_{i}_{j}'
                            key_b = f'B_{i}_{j}'
                            if key_a in fits_keywords:
                                a[i, j] = float(fits_keywords[key_a])
                            if key_b in fits_keywords:
                                b[i, j] = float(fits_keywords[key_b])

                # 逆SIP係数
                ap = np.zeros((sip_order + 1, sip_order + 1))
                bp = np.zeros((sip_order + 1, sip_order + 1))

                if 'AP_ORDER' in fits_keywords:
                    ap_order = int(fits_keywords['AP_ORDER'])
                    for i in range(ap_order + 1):
                        for j in range(ap_order + 1 - i):
                            key = f'AP_{i}_{j}'
                            if key in fits_keywords:
                                ap[i, j] = float(fits_keywords[key])

                if 'BP_ORDER' in fits_keywords:
                    bp_order = int(fits_keywords['BP_ORDER'])
                    for i in range(bp_order + 1):
                        for j in range(bp_order + 1 - i):
                            key = f'BP_{i}_{j}'
                            if key in fits_keywords:
                                bp[i, j] = float(fits_keywords[key])

                wcs.sip = Sip(a, b, ap, bp, crpix)

            return wcs

        except Exception as e:
            logger.warning(f"Failed to construct WCS from FITS keywords: {e}")
            return None

    @staticmethod
    def convert_to_fits_header(metadata: Dict) -> fits.Header:
        """
        XISFメタデータをFITSヘッダーに変換
        （image_splitter等で使用）
        """
        header = fits.Header()

        fits_keywords = metadata.get('fits_keywords', {})

        for name, value in fits_keywords.items():
            try:
                # xisfライブラリの形式 (list of dicts) から値を抽出
                if isinstance(value, list) and len(value) > 0:
                    if isinstance(value[0], dict) and 'value' in value[0]:
                        # 最初のエントリの値を取得
                        extracted_value = value[0]['value']
                        # 型変換を試みる
                        try:
                            if '.' in extracted_value or 'e' in extracted_value.lower():
                                header[name] = float(extracted_value)
                            else:
                                header[name] = int(extracted_value)
                        except (ValueError, AttributeError):
                            header[name] = extracted_value
                    else:
                        header[name] = value
                else:
                    header[name] = value
            except Exception as e:
                logger.debug(f"Failed to add keyword {name}: {e}")

        return header
