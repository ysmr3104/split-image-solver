// test_split_tiles.js
// splitImageToTiles の PJSR ユニットテスト
//
// 実行:
//   bash tests/pjsr/run_pjsr_tests.sh tests/pjsr/test_split_tiles.js

// PixInsight --automation-mode では #include が使えるため、
// ライブラリモードでメインスクリプトを読み込む
var __SPLIT_SOLVER_LIBRARY_MODE = true;

#include <pjsr/UndoFlag.jsh>
#include <pjsr/ImageOp.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/StdCursor.jsh>

#include "../../javascript/SplitImageSolver.js"
#include "pjsr_test_framework.js"

var PROJECT_ROOT = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__) + "/../../";
var RESULT_PATH = PROJECT_ROOT + "tests/pjsr/results/test_split_tiles_result.json";

// ============================================================
// ヘルパー: 指定サイズのダミーImageWindowを作成（uint16グレースケール）
// ============================================================
function makeDummyWindow(w, h, id) {
    var win = new ImageWindow(w, h, 1, 16, false, false, id || "dummy");
    win.mainView.beginProcess(UndoFlag_NoSwapFile);
    // 全画素を0.5に設定（星らしきものがないとstretchに影響するが関係なし）
    win.mainView.image.fill(0.5);
    win.mainView.endProcess();
    return win;
}

// ============================================================
// テスト
// ============================================================

test("2x2 分割でタイル数が4", function() {
    var win = makeDummyWindow(400, 300, "test2x2");
    var tiles = splitImageToTiles(win, 2, 2, 0, null);
    win.forceClose();
    assertEqual(tiles.length, 4, "tile count");
});

test("2x2 offsetX/offsetY が正しい", function() {
    // 400x300 → baseTileW=200, baseTileH=150
    var win = makeDummyWindow(400, 300, "testOffsets");
    var tiles = splitImageToTiles(win, 2, 2, 0, null);
    win.forceClose();

    // col=0 → offsetX=0, col=1 → offsetX=200
    // row=0 → offsetY=0, row=1 → offsetY=150
    var tileMap = {};
    for (var i = 0; i < tiles.length; i++) {
        tileMap[tiles[i].col + "_" + tiles[i].row] = tiles[i];
    }
    assertEqual(tileMap["0_0"].offsetX, 0,   "col0 offsetX");
    assertEqual(tileMap["0_0"].offsetY, 0,   "row0 offsetY");
    assertEqual(tileMap["1_0"].offsetX, 200, "col1 offsetX");
    assertEqual(tileMap["0_1"].offsetY, 150, "row1 offsetY");
});

test("オーバーラップが端でゼロクランプ", function() {
    // 400x300, overlap=20
    // col=0 の x0 = 0*200 - 20 = -20 → クランプして 0
    var win = makeDummyWindow(400, 300, "testOverlap");
    var tiles = splitImageToTiles(win, 2, 2, 20, null);
    win.forceClose();

    var tileMap = {};
    for (var i = 0; i < tiles.length; i++) {
        tileMap[tiles[i].col + "_" + tiles[i].row] = tiles[i];
    }

    // 左端タイルのoffsetXは0（クランプ）
    assertEqual(tileMap["0_0"].offsetX, 0, "左端 offsetX はクランプされて0");
    // 上端タイルのoffsetYは0（クランプ）
    assertEqual(tileMap["0_0"].offsetY, 0, "上端 offsetY はクランプされて0");
    // 内側タイル(col=1,row=0)のoffsetXはオーバーラップ分引かれてx0 = 200-20 = 180
    assertEqual(tileMap["1_0"].offsetX, 180, "col1 オーバーラップ offsetX");
});

test("skipEdges でエッジタイルが除外される（3x3 の外周を除外）", function() {
    // 3x3 grid, skip全外周 → 中央1タイルのみ
    var win = makeDummyWindow(300, 300, "testSkipEdges");
    var tiles = splitImageToTiles(win, 3, 3, 0, { top: 1, bottom: 1, left: 1, right: 1 });
    win.forceClose();
    assertEqual(tiles.length, 1, "中央タイルのみ残る");
    assertEqual(tiles[0].col, 1, "col=1");
    assertEqual(tiles[0].row, 1, "row=1");
});

test("大画像（長辺>2000px）で scaleFactor < 1", function() {
    // 4000x3000 の大画像 → maxEdge=4000 → scaleFactor=2000/4000=0.5
    var win = makeDummyWindow(4000, 3000, "testLargeScale");
    var tiles = splitImageToTiles(win, 1, 1, 0, null);
    win.forceClose();
    assertEqual(tiles.length, 1, "タイル数1");
    assertTrue(tiles[0].scaleFactor < 1.0, "scaleFactor < 1 (actual=" + tiles[0].scaleFactor + ")");
    assertEqual(tiles[0].scaleFactor, 0.5, "scaleFactor=0.5", 0.01);
});

test("小画像（長辺<=2000px）で scaleFactor = 1", function() {
    // 800x600 → scaleFactor=1.0
    var win = makeDummyWindow(800, 600, "testSmallScale");
    var tiles = splitImageToTiles(win, 1, 1, 0, null);
    win.forceClose();
    assertEqual(tiles[0].scaleFactor, 1.0, "scaleFactor=1.0");
});

test("タイルFITSファイルが生成される", function() {
    var win = makeDummyWindow(200, 200, "testFitsOut");
    var tiles = splitImageToTiles(win, 2, 2, 0, null);
    win.forceClose();
    var allExist = true;
    for (var i = 0; i < tiles.length; i++) {
        if (!File.exists(tiles[i].filePath)) {
            allExist = false;
            break;
        }
    }
    assertTrue(allExist, "全タイルFITSファイルが存在する");
    // クリーンアップ
    for (var j = 0; j < tiles.length; j++) {
        try { File.remove(tiles[j].filePath); } catch (e) {}
    }
});

// ============================================================
// 実行
// ============================================================
runAllTests(RESULT_PATH);
