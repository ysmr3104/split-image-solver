//----------------------------------------------------------------------------
//SplitImageSolver.js - PixInsight JavaScript Runtime (PJSR) Script
//
//Split Image Solver: 広角星空画像を分割してプレートソルブし、
//統合したWCS情報を元画像に書き込むPixInsightスクリプト
//
//Copyright (c) 2024-2025 Split Image Solver Project
//----------------------------------------------------------------------------

#feature-id    SplitImageSolver: Utilities > SplitImageSolver
#feature-info  広角星空画像を分割プレートソルブしWCSを統合します。Pythonバックエンドでastrometry.net照合とWCS統合を行います。

#define VERSION "1.0.1"

#include <pjsr/DataType.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/NumericControl.jsh>

   // パス内のスペースをシェル用にエスケープ
   function quotePath(path) {
      return "'" + path.replace(/'/g, "'\\''") + "'";
   }

   function byteArrayToString(ba) {
      if (!ba || ba.length === 0) return "";
      try {
         var s = "";
         for (var i = 0; i < ba.length; ++i) {
            var c = ba.at(i);
            if (c > 0) s += String.fromCharCode(c);
         }
         return s;
      } catch (e) {
         console.warningln("byteArrayToString failed: " + e.message);
         return "";
      }
   }

   // RA入力をパース（HMS "HH MM SS.ss" / "HH:MM:SS.ss" または度数）
   function parseRAInput(text) {
      text = text.trim();
      if (text.length === 0) return undefined;
      var parts = text.split(/[\s:]+/);
      if (parts.length >= 3) {
         var h = parseFloat(parts[0]);
         var m = parseFloat(parts[1]);
         var s = parseFloat(parts[2]);
         if (!isNaN(h) && !isNaN(m) && !isNaN(s))
            return (h + m / 60.0 + s / 3600.0) * 15.0;
      }
      var v = parseFloat(text);
      return isNaN(v) ? undefined : v;
   }

   // DEC入力をパース（DMS "±DD MM SS.ss" / "±DD:MM:SS.ss" または度数）
   function parseDECInput(text) {
      text = text.trim();
      if (text.length === 0) return undefined;
      var sign = 1;
      if (text.charAt(0) === '-') { sign = -1; text = text.substring(1); }
      else if (text.charAt(0) === '+') { text = text.substring(1); }
      var parts = text.split(/[\s:]+/);
      if (parts.length >= 3) {
         var d = parseFloat(parts[0]);
         var m = parseFloat(parts[1]);
         var s = parseFloat(parts[2]);
         if (!isNaN(d) && !isNaN(m) && !isNaN(s))
            return sign * (d + m / 60.0 + s / 3600.0);
      }
      var v = parseFloat(text);
      return isNaN(v) ? undefined : sign * v;
   }

   // 度数をHMS文字列に変換
   function degreesToHMS(deg) {
      if (deg < 0) deg += 360;
      var h = deg / 15.0;
      var hours = Math.floor(h);
      var rem = (h - hours) * 60;
      var minutes = Math.floor(rem);
      var seconds = (rem - minutes) * 60;
      return format("%02d %02d %05.2f", hours, minutes, seconds);
   }

   // 度数をDMS文字列に変換
   function degreesToDMS(deg) {
      var sign = deg >= 0 ? "+" : "-";
      var d = Math.abs(deg);
      var degrees = Math.floor(d);
      var rem = (d - degrees) * 60;
      var minutes = Math.floor(rem);
      var seconds = (rem - minutes) * 60;
      return format("%s%02d %02d %05.2f", sign, degrees, minutes, seconds);
   }

   // WCS関連のFITSキーワードかどうかを判定
   function isWCSKeyword(name) {
      var wcsNames = [
         "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2",
         "CD1_1", "CD1_2", "CD2_1", "CD2_2",
         "CDELT1", "CDELT2", "CROTA1", "CROTA2",
         "CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2",
         "RADESYS", "EQUINOX",
         "A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER",
         "PLTSOLVD"
      ];
      for (var i = 0; i < wcsNames.length; i++) {
         if (name === wcsNames[i]) return true;
      }
      // SIP係数: A_i_j, B_i_j, AP_i_j, BP_i_j
      if (/^[AB]P?_\d+_\d+$/.test(name)) return true;
      return false;
   }

   // FITSKeywordの型を値から判定して適切なFITSKeywordオブジェクトを生成
   function makeFITSKeyword(name, value) {
      var strVal = value.toString();
      // 論理値
      if (strVal === "T" || strVal === "true") {
         return new FITSKeyword(name, "T", "");
      }
      if (strVal === "F" || strVal === "false") {
         return new FITSKeyword(name, "F", "");
      }
      // 文字列型のCTYPE, CUNIT, RADESYS等
      var stringKeys = ["CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2", "RADESYS", "PLTSOLVD"];
      for (var i = 0; i < stringKeys.length; i++) {
         if (name === stringKeys[i]) {
            return new FITSKeyword(name, "'" + strVal + "'", "");
         }
      }
      // 数値（整数または浮動小数点）
      return new FITSKeyword(name, strVal, "");
   }

   // 天体名からRA/DECを検索（CDS Sesame name resolver）
   function searchObjectCoordinates(objectName) {
      var encoded = objectName.replace(/ /g, "+");
      var url = "http://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-oI/A?" + encoded;
      var tmpFile = File.systemTempDirectory + "/sesame_query.txt";

      var P = new ExternalProcess;
      P.start("/usr/bin/curl", ["-s", "-o", tmpFile, "-m", "10", url]);
      if (!P.waitForFinished(15000)) {
         P.kill();
         return null;
      }
      if (P.exitCode !== 0) return null;

      if (!File.exists(tmpFile)) return null;
      var content = "";
      try {
         content = File.readTextFile(tmpFile);
         File.remove(tmpFile);
      } catch (e) {
         return null;
      }

      // %J 行から座標を取得: "%J 83.82208 -5.39111 = 05:35:17.30 -05:23:28.0"
      var lines = content.split("\n");
      for (var i = 0; i < lines.length; i++) {
         var line = lines[i].trim();
         if (line.indexOf("%J") === 0) {
            var coords = line.substring(2).trim();
            var eqIdx = coords.indexOf("=");
            if (eqIdx > 0) coords = coords.substring(0, eqIdx).trim();
            var parts = coords.split(/\s+/);
            if (parts.length >= 2) {
               var ra = parseFloat(parts[0]);
               var dec = parseFloat(parts[1]);
               if (!isNaN(ra) && !isNaN(dec))
                  return { ra: ra, dec: dec };
            }
         }
      }
      return null;
   }


#define TITLE   "Split Image Solver"

//============================================================================
//Settings keys for persistence
//============================================================================
#define SETTINGS_KEY_PREFIX "SplitImageSolver/"
#define KEY_PYTHON_PATH    SETTINGS_KEY_PREFIX + "pythonPath"
#define KEY_SCRIPT_DIR     SETTINGS_KEY_PREFIX + "scriptDir"
#define KEY_GRID           SETTINGS_KEY_PREFIX + "grid"
#define KEY_OVERLAP        SETTINGS_KEY_PREFIX + "overlap"

//============================================================================
//SolverParameters - パラメータの保持と永続化
//============================================================================
function SolverParameters() {
   //環境設定（Settings APIで永続化）
   this.pythonPath = "";
   this.scriptDir = "";

   //実行パラメータ
   this.grid = "3x3";
   this.overlap = 100;
   this.ra = undefined;
   this.dec = undefined;
   this.focalLength = undefined;
   this.pixelPitch = undefined;

   //Settings APIから読み込み
   this.load = function () {
      var val;
      try {
         val = Settings.read(KEY_PYTHON_PATH, DataType_String);
         if (val !== null)
            this.pythonPath = val;
      } catch (e) { }

      try {
         val = Settings.read(KEY_SCRIPT_DIR, DataType_String);
         if (val !== null)
            this.scriptDir = val;
      } catch (e) { }

      try {
         val = Settings.read(KEY_GRID, DataType_String);
         if (val !== null)
            this.grid = val;
      } catch (e) { }

      try {
         val = Settings.read(KEY_OVERLAP, DataType_Int32);
         if (val !== null)
            this.overlap = val;
      } catch (e) { }
   };

   //Settings APIに保存
   this.save = function () {
      Settings.write(KEY_PYTHON_PATH, DataType_String, this.pythonPath);
      Settings.write(KEY_SCRIPT_DIR, DataType_String, this.scriptDir);
      Settings.write(KEY_GRID, DataType_String, this.grid);
      Settings.write(KEY_OVERLAP, DataType_Int32, this.overlap);
   };

   //環境設定が有効かチェック
   this.isConfigured = function () {
      return this.pythonPath.length > 0 && this.scriptDir.length > 0;
   };
}

//============================================================================
//SolverEngine - Pythonバックエンド呼び出し
//============================================================================
function SolverEngine() {
   //FITSキーワードからメタデータを自動取得
   this.extractMetadataFromWindow = function (window) {
      var result = {
         ra: undefined,
         dec: undefined,
         pixelScale: undefined,
         focalLength: undefined,
         pixelSize: undefined
      };

      var keywords = window.keywords;
      for (var i = 0; i < keywords.length; i++) {
         var kw = keywords[i];
         switch (kw.name) {
            case "RA":
               result.ra = parseFloat(kw.strippedValue);
               break;
            case "OBJCTRA":
               //HMS形式の場合: "HH MM SS.ss" → degrees
               result.ra = this.hmsToDegreesRA(kw.strippedValue);
               break;
            case "DEC":
               result.dec = parseFloat(kw.strippedValue);
               break;
            case "OBJCTDEC":
               //DMS形式の場合: "+DD MM SS.ss" → degrees
               result.dec = this.dmsToDegreesDec(kw.strippedValue);
               break;
            case "FOCALLEN":
               result.focalLength = parseFloat(kw.strippedValue);
               break;
            case "XPIXSZ":
               result.pixelSize = parseFloat(kw.strippedValue);
               break;
         }
      }

      //RA: degrees形式を優先（OBJCTRAはRA未取得時のフォールバック）
      //ピクセルスケールを計算: 206.265 * pixelSize(μm) /focalLength(mm)
      if (result.focalLength && result.pixelSize) {
         result.pixelScale = (206.265 * result.pixelSize) / result.focalLength;
      }

      return result;
   };

   //HMS文字列 "HH MM SS.ss" をdegrees に変換
   this.hmsToDegreesRA = function (hmsStr) {
      var parts = hmsStr.trim().split(/[\s:]+/);
      if (parts.length < 3) return undefined;
      var h = parseFloat(parts[0]);
      var m = parseFloat(parts[1]);
      var s = parseFloat(parts[2]);
      return (h + m / 60.0 + s / 3600.0) * 15.0;  //hours → degrees
   };

   //DMS文字列 "+DD MM SS.ss" をdegrees に変換
   this.dmsToDegreesDec = function (dmsStr) {
      var str = dmsStr.trim();
      var sign = 1;
      if (str.charAt(0) === '-') {
         sign = -1;
         str = str.substring(1);
      }
      else if (str.charAt(0) === '+') {
         str = str.substring(1);
      }
      var parts = str.split(/[\s:]+/);
      if (parts.length < 3) return undefined;
      var d = parseFloat(parts[0]);
      var m = parseFloat(parts[1]);
      var s = parseFloat(parts[2]);
      return sign * (d + m / 60.0 + s / 3600.0);
   };

   //コマンド配列を構築
   this.buildCommand = function (inputPath, outputPath, params) {
      var scriptPath = params.scriptDir + "/python/main.py";

      var args = [
         params.pythonPath,
         scriptPath,
         "--input", inputPath,
         "--output", outputPath,
         "--grid", params.grid,
         "--overlap", params.overlap.toString(),
         "--json-output"
      ];

      if (params.ra !== undefined && params.ra !== null) {
         args.push("--ra");
         args.push(params.ra.toString());
      }
      if (params.dec !== undefined && params.dec !== null) {
         args.push("--dec");
         args.push(params.dec.toString());
      }
      if (params.focalLength !== undefined && params.focalLength !== null
         && params.pixelPitch !== undefined && params.pixelPitch !== null) {
         var pixelScale = (206.265 * params.pixelPitch) / params.focalLength;
         args.push("--pixel-scale");
         args.push(pixelScale.toFixed(4));
      }

      return args;
   };

   //Python main.pyを実行
   this.execute = function (inputPath, outputPath, params) {
      var args = this.buildCommand(inputPath, outputPath, params);

      console.writeln("<b>Split Image Solver: Executing...</b>");
      console.writeln("Command: " + args.join(" "));
      console.flush();

      var P = new ExternalProcess;

      //作業ディレクトリをスクリプトディレクトリに設定
      P.workingDirectory = params.scriptDir;

      // ExternalProcess.start() はパス内のスペースを正しく扱えないため
      // /bin/sh -c 経由でクォート付きコマンドを実行する
      var cmdParts = [];
      for (var i = 0; i < args.length; i++) {
         cmdParts.push(quotePath(args[i]));
      }

      // macOS GUIアプリはHomebrew等のPATHを持たないため、
      // Python実行ファイルのディレクトリとHomebrewパスをPATHに追加
      var pythonDir = File.extractDirectory(params.pythonPath);
      var pathPrefix = "export PATH="
         + quotePath(pythonDir)
         + ":/opt/homebrew/bin:/usr/local/bin:$PATH; ";

      // ExternalProcess が /bin/sh 子プロセスの出力をキャプチャできない場合に備え
      // stdout/stderr をテンポラリファイルにリダイレクトして読み戻す
      var stdoutFile = File.systemTempDirectory + "/split_solver_stdout.log";
      var stderrFile = File.systemTempDirectory + "/split_solver_stderr.log";
      var shellCmd = pathPrefix + cmdParts.join(" ")
         + " > " + quotePath(stdoutFile)
         + " 2> " + quotePath(stderrFile);
      console.writeln("Shell command: " + shellCmd);

      P.start("/bin/sh", ["-c", shellCmd]);

      // Process Console の Abort ボタンを有効化
      console.abortEnabled = true;
      console.writeln("Press <b>Abort</b> button in Process Console to cancel.");
      console.flush();

      // ポーリングループで完了を待機（Abort 対応）
      var timeoutMs = 30 * 60 * 1000;
      var pollIntervalMs = 500;
      var elapsed = 0;
      var aborted = false;
      var lastStderrSize = 0;

      while (elapsed < timeoutMs) {
         if (P.waitForFinished(pollIntervalMs)) {
            break; // プロセス完了
         }

         processEvents();

         if (console.abortRequested) {
            console.writeln("");
            console.warningln("<b>Abort requested by user. Killing process...</b>");
            P.kill();
            aborted = true;
            break;
         }

         // stderr をリアルタイム表示（進捗確認用）
         try {
            if (File.exists(stderrFile)) {
               var currentStderr = File.readTextFile(stderrFile);
               if (currentStderr.length > lastStderrSize) {
                  var newOutput = currentStderr.substring(lastStderrSize).trim();
                  if (newOutput.length > 0) {
                     var newLines = newOutput.split("\n");
                     for (var li = 0; li < newLines.length; li++) {
                        console.writeln("[PYTHON] " + newLines[li]);
                     }
                     console.flush();
                  }
                  lastStderrSize = currentStderr.length;
               }
            }
         } catch (e) {
            // ファイル読み込み失敗は無視（書き込み中の競合等）
         }

         elapsed += pollIntervalMs;
      }

      console.abortEnabled = false;

      if (aborted) {
         try { if (File.exists(stdoutFile)) File.remove(stdoutFile); } catch (e) {}
         try { if (File.exists(stderrFile)) File.remove(stderrFile); } catch (e) {}
         throw new Error("Process aborted by user");
      }

      if (elapsed >= timeoutMs && !P.waitForFinished(0)) {
         P.kill();
         try { if (File.exists(stdoutFile)) File.remove(stdoutFile); } catch (e) {}
         try { if (File.exists(stderrFile)) File.remove(stderrFile); } catch (e) {}
         throw new Error("Process timed out after 30 minutes");
      }

      //テンポラリファイルから出力を読み戻す
      var stdout = "";
      var stderr = "";
      try {
         if (File.exists(stdoutFile)) {
            stdout = File.readTextFile(stdoutFile).trim();
            File.remove(stdoutFile);
         }
      } catch (e) {
         console.warningln("Failed to read stdout log: " + e.message);
      }
      try {
         if (File.exists(stderrFile)) {
            stderr = File.readTextFile(stderrFile).trim();
            File.remove(stderrFile);
         }
      } catch (e) {
         console.warningln("Failed to read stderr log: " + e.message);
      }

      console.writeln("Stdout length: " + stdout.length + " chars");
      console.writeln("Stderr length: " + stderr.length + " chars");

      // ポーリング中にリアルタイム表示されなかった残りの stderr を表示
      if (stderr.length > lastStderrSize) {
         var remainingStderr = stderr.substring(lastStderrSize).trim();
         if (remainingStderr.length > 0) {
            var stderrLines = remainingStderr.split("\n");
            for (var i = 0; i < stderrLines.length; i++)
               console.writeln("[PYTHON] " + stderrLines[i]);
         }
      }

      if (P.exitCode !== 0) {
         console.warningln("Process exited with code: " + P.exitCode);
         if (stdout.length > 0) {
            console.writeln("--- stdout START ---");
            var stdoutLines = stdout.split("\n");
            for (var i = 0; i < Math.min(stdoutLines.length, 100); i++)
               console.writeln(stdoutLines[i]);
            if (stdoutLines.length > 100)
               console.writeln("... (truncated)");
            console.writeln("--- stdout END ---");
         }

         if (stdout.length > 0) {
            try {
               var result = JSON.parse(stdout);
               if (result.error) throw new Error("Solver failed: " + result.error);
            } catch (e) {
               if (e.message.indexOf("Solver failed") === 0) throw e;
            }
         }
         throw new Error("Solver process exited with code " + P.exitCode);
      }
      // JSONパース（正常終了時またはエラー詳細取得用）
      if (stdout.length > 0) {
         //stdoutの最後の行がJSON（ログ混入対策）
         var lines = stdout.split("\n");
         for (var i = lines.length - 1; i >= 0; i--) {
            var line = lines[i].trim();
            if (line.length > 0 && line.charAt(0) === '{') {
               try {
                  var result = JSON.parse(line);
                  console.writeln(format(
                     "<b>Result:</b> %d/%d tiles solved, CRVAL=(%.4f, %.4f)",
                     result.tiles_solved, result.tiles_total,
                     result.wcs.crval1, result.wcs.crval2
                  ));
                  return result;
               }
               catch (e) {
                  //JSONパース失敗 → 次の行を試行
               }
            }
         }
      }

      console.writeln("Solver completed successfully (no JSON output found)");
      return { success: true };
   };
}

//============================================================================
//SettingsDialog - Python環境設定ダイアログ
//============================================================================
function SettingsDialog(params) {
   this.__base__ = Dialog;
   this.__base__();

   this.params = params;

   this.windowTitle = TITLE + " - Settings";
   this.minWidth = 500;

   //--- Python path ---
   var pythonLabel = new Label(this);
   pythonLabel.text = "Python executable:";
   pythonLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.pythonEdit = new Edit(this);
   this.pythonEdit.text = params.pythonPath;
   this.pythonEdit.toolTip = "Path to the Python executable (e.g., /usr/bin/python3)";
   this.pythonEdit.onTextUpdated = function () {
      params.pythonPath = this.dialog.pythonEdit.text.trim();
   };

   var pythonBrowse = new ToolButton(this);
   pythonBrowse.icon = this.scaledResource(":/icons/select-file.png");
   pythonBrowse.setScaledFixedSize(22, 22);
   pythonBrowse.toolTip = "Browse for Python executable";
   pythonBrowse.onClick = function () {
      var fd = new OpenFileDialog;
      fd.caption = "Select Python Executable";
      if (fd.execute()) {
         this.dialog.pythonEdit.text = fd.fileName;
         params.pythonPath = fd.fileName;
      }
   };

   var pythonSizer = new HorizontalSizer;
   pythonSizer.spacing = 4;
   pythonSizer.add(pythonLabel);
   pythonSizer.add(this.pythonEdit, 100);
   pythonSizer.add(pythonBrowse);

   //--- Script directory ---
   var scriptDirLabel = new Label(this);
   scriptDirLabel.text = "Script directory:";
   scriptDirLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.scriptDirEdit = new Edit(this);
   this.scriptDirEdit.text = params.scriptDir;
   this.scriptDirEdit.toolTip = "Path to the split-image-solver directory";
   this.scriptDirEdit.onTextUpdated = function () {
      params.scriptDir = this.dialog.scriptDirEdit.text.trim();
   };

   var scriptDirBrowse = new ToolButton(this);
   scriptDirBrowse.icon = this.scaledResource(":/icons/select-file.png");
   scriptDirBrowse.setScaledFixedSize(22, 22);
   scriptDirBrowse.toolTip = "Browse for script directory";
   scriptDirBrowse.onClick = function () {
      var gdd = new GetDirectoryDialog;
      gdd.caption = "Select split-image-solver Directory";
      if (gdd.execute()) {
         this.dialog.scriptDirEdit.text = gdd.directory;
         params.scriptDir = gdd.directory;
      }
   };

   var scriptDirSizer = new HorizontalSizer;
   scriptDirSizer.spacing = 4;
   scriptDirSizer.add(scriptDirLabel);
   scriptDirSizer.add(this.scriptDirEdit, 100);
   scriptDirSizer.add(scriptDirBrowse);

   //--- Buttons ---
   this.okButton = new PushButton(this);
   this.okButton.text = "OK";
   this.okButton.icon = this.scaledResource(":/icons/ok.png");
   this.okButton.onClick = function () {
      //Validate
      if (params.pythonPath.length === 0) {
         var mb = new MessageBox(
            "Please specify the Python executable path.",
            TITLE, StdIcon_Error, StdButton_Ok);
         mb.execute();
         return;
      }
      if (params.scriptDir.length === 0) {
         var mb = new MessageBox(
            "Please specify the script directory.",
            TITLE, StdIcon_Error, StdButton_Ok);
         mb.execute();
         return;
      }
      this.dialog.ok();
   };

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.icon = this.scaledResource(":/icons/cancel.png");
   this.cancelButton.onClick = function () {
      this.dialog.cancel();
   };

   var buttonSizer = new HorizontalSizer;
   buttonSizer.addStretch();
   buttonSizer.spacing = 8;
   buttonSizer.add(this.okButton);
   buttonSizer.add(this.cancelButton);

   //--- Layout ---
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add(pythonSizer);
   this.sizer.add(scriptDirSizer);
   this.sizer.addSpacing(8);
   this.sizer.add(buttonSizer);

   this.adjustToContents();
}

SettingsDialog.prototype = new Dialog;

//============================================================================
//ParameterDialog - 実行パラメータ設定ダイアログ
//============================================================================
function ParameterDialog(params, windowInfo) {
   this.__base__ = Dialog;
   this.__base__();

   this.params = params;

   this.windowTitle = TITLE;
   this.minWidth = 480;

   //--- Image info (read-only) ---
   var infoGroup = new GroupBox(this);
   infoGroup.title = "Image";

   var imageNameLabel = new Label(infoGroup);
   imageNameLabel.text = "Target: " + windowInfo.name;

   var imageSizeLabel = new Label(infoGroup);
   imageSizeLabel.text = format("Size: %d x %d px", windowInfo.width, windowInfo.height);

   infoGroup.sizer = new VerticalSizer;
   infoGroup.sizer.margin = 6;
   infoGroup.sizer.spacing = 4;
   infoGroup.sizer.add(imageNameLabel);
   infoGroup.sizer.add(imageSizeLabel);

   //--- Grid settings ---
   var gridGroup = new GroupBox(this);
   gridGroup.title = "Split Settings";

   var gridLabel = new Label(gridGroup);
   gridLabel.text = "Grid:";
   gridLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   gridLabel.setFixedWidth(120);

   this.gridCombo = new ComboBox(gridGroup);
   this.gridCombo.addItem("2x2");
   this.gridCombo.addItem("3x3");
   this.gridCombo.addItem("4x4");

   //現在の設定に合わせて選択
   var gridOptions = ["2x2", "3x3", "4x4"];
   var gridIndex = gridOptions.indexOf(params.grid);
   this.gridCombo.currentItem = gridIndex >= 0 ? gridIndex : 1; //default: 3x3

   this.gridCombo.onItemSelected = function (index) {
      params.grid = gridOptions[index];
   };

   var gridSizer = new HorizontalSizer;
   gridSizer.spacing = 4;
   gridSizer.add(gridLabel);
   gridSizer.add(this.gridCombo);
   gridSizer.addStretch();

   var overlapLabel = new Label(gridGroup);
   overlapLabel.text = "Overlap:";
   overlapLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   overlapLabel.setFixedWidth(120);

   this.overlapSpin = new SpinBox(gridGroup);
   this.overlapSpin.minValue = 0;
   this.overlapSpin.maxValue = 1000;
   this.overlapSpin.value = params.overlap;
   this.overlapSpin.toolTip = "Overlap pixels between tiles";
   this.overlapSpin.onValueUpdated = function (value) {
      params.overlap = value;
   };

   var overlapUnitLabel = new Label(gridGroup);
   overlapUnitLabel.text = "px";

   var overlapSizer = new HorizontalSizer;
   overlapSizer.spacing = 4;
   overlapSizer.add(overlapLabel);
   overlapSizer.add(this.overlapSpin);
   overlapSizer.add(overlapUnitLabel);
   overlapSizer.addStretch();

   gridGroup.sizer = new VerticalSizer;
   gridGroup.sizer.margin = 6;
   gridGroup.sizer.spacing = 4;
   gridGroup.sizer.add(gridSizer);
   gridGroup.sizer.add(overlapSizer);

   //--- Coordinate hints ---
   var coordGroup = new GroupBox(this);
   coordGroup.title = "Coordinate Hints";

   var dialog = this;

   // Object name search
   var objLabel = new Label(coordGroup);
   objLabel.text = "Object name:";
   objLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   objLabel.setFixedWidth(120);

   this.objectNameEdit = new Edit(coordGroup);
   this.objectNameEdit.toolTip = "Enter object name to search (e.g., M42, NGC2024, Orion Nebula)";

   this.searchButton = new PushButton(coordGroup);
   this.searchButton.text = "Search";
   this.searchButton.icon = this.scaledResource(":/icons/find.png");
   this.searchButton.toolTip = "Search coordinates using CDS Sesame name resolver";
   this.searchButton.onClick = function () {
      var name = dialog.objectNameEdit.text.trim();
      if (name.length === 0) {
         var mb = new MessageBox("Please enter an object name.",
            TITLE, StdIcon_Warning, StdButton_Ok);
         mb.execute();
         return;
      }
      console.writeln("Searching for: " + name + " ...");
      console.flush();
      var result = searchObjectCoordinates(name);
      if (result) {
         dialog.raEdit.text = degreesToHMS(result.ra);
         dialog.decEdit.text = degreesToDMS(result.dec);
         params.ra = result.ra;
         params.dec = result.dec;
         console.writeln(format("Found: RA=%s (%.4f\u00B0), DEC=%s (%.4f\u00B0)",
            degreesToHMS(result.ra), result.ra,
            degreesToDMS(result.dec), result.dec));
      } else {
         var mb = new MessageBox(
            "Object '" + name + "' not found.\n\n" +
            "Please check the name and try again.\n" +
            "Examples: M42, NGC2024, IC434, Vega",
            TITLE, StdIcon_Warning, StdButton_Ok);
         mb.execute();
      }
   };

   var objSizer = new HorizontalSizer;
   objSizer.spacing = 4;
   objSizer.add(objLabel);
   objSizer.add(this.objectNameEdit, 100);
   objSizer.add(this.searchButton);

   // RA (HMS format)
   var raLabel = new Label(coordGroup);
   raLabel.text = "RA:";
   raLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   raLabel.setFixedWidth(120);

   this.raEdit = new Edit(coordGroup);
   this.raEdit.text = (params.ra !== undefined && params.ra !== null)
      ? degreesToHMS(params.ra) : "";
   this.raEdit.toolTip = "Right Ascension: HH MM SS.ss (or degrees)";
   this.raEdit.setFixedWidth(160);
   this.raEdit.onTextUpdated = function () {
      params.ra = parseRAInput(dialog.raEdit.text);
   };

   var raHintLabel = new Label(coordGroup);
   raHintLabel.text = "(HH MM SS.ss)";

   var raSizer = new HorizontalSizer;
   raSizer.spacing = 4;
   raSizer.add(raLabel);
   raSizer.add(this.raEdit);
   raSizer.add(raHintLabel);
   raSizer.addStretch();

   // DEC (DMS format)
   var decLabel = new Label(coordGroup);
   decLabel.text = "DEC:";
   decLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   decLabel.setFixedWidth(120);

   this.decEdit = new Edit(coordGroup);
   this.decEdit.text = (params.dec !== undefined && params.dec !== null)
      ? degreesToDMS(params.dec) : "";
   this.decEdit.toolTip = "Declination: \u00B1DD MM SS.ss (or degrees)";
   this.decEdit.setFixedWidth(160);
   this.decEdit.onTextUpdated = function () {
      params.dec = parseDECInput(dialog.decEdit.text);
   };

   var decHintLabel = new Label(coordGroup);
   decHintLabel.text = "(\u00B1DD MM SS.ss)";

   var decSizer = new HorizontalSizer;
   decSizer.spacing = 4;
   decSizer.add(decLabel);
   decSizer.add(this.decEdit);
   decSizer.add(decHintLabel);
   decSizer.addStretch();

   // Focal length
   var flLabel = new Label(coordGroup);
   flLabel.text = "Focal length:";
   flLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   flLabel.setFixedWidth(120);

   this.focalLengthEdit = new Edit(coordGroup);
   this.focalLengthEdit.text = (params.focalLength !== undefined && params.focalLength !== null)
      ? params.focalLength.toString() : "";
   this.focalLengthEdit.toolTip = "Focal length in mm";
   this.focalLengthEdit.setFixedWidth(120);

   var flUnitLabel = new Label(coordGroup);
   flUnitLabel.text = "mm";

   var flSizer = new HorizontalSizer;
   flSizer.spacing = 4;
   flSizer.add(flLabel);
   flSizer.add(this.focalLengthEdit);
   flSizer.add(flUnitLabel);
   flSizer.addStretch();

   // Pixel pitch
   var ppLabel = new Label(coordGroup);
   ppLabel.text = "Pixel pitch:";
   ppLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   ppLabel.setFixedWidth(120);

   this.pixelPitchEdit = new Edit(coordGroup);
   this.pixelPitchEdit.text = (params.pixelPitch !== undefined && params.pixelPitch !== null)
      ? params.pixelPitch.toString() : "";
   this.pixelPitchEdit.toolTip = "Pixel pitch (pixel size) in micrometers";
   this.pixelPitchEdit.setFixedWidth(120);

   var ppUnitLabel = new Label(coordGroup);
   ppUnitLabel.text = "\u00B5m";

   // 計算されたピクセルスケール表示ラベル
   this.scaleInfoLabel = new Label(coordGroup);
   this.scaleInfoLabel.text = "";

   var ppSizer = new HorizontalSizer;
   ppSizer.spacing = 4;
   ppSizer.add(ppLabel);
   ppSizer.add(this.pixelPitchEdit);
   ppSizer.add(ppUnitLabel);
   ppSizer.addSpacing(8);
   ppSizer.add(this.scaleInfoLabel);
   ppSizer.addStretch();

   // ピクセルスケール表示とExecuteボタン有効化を更新するヘルパー
   var updateScaleAndButton = function () {
      var fl = parseFloat(dialog.focalLengthEdit.text);
      var pp = parseFloat(dialog.pixelPitchEdit.text);
      params.focalLength = isNaN(fl) ? undefined : fl;
      params.pixelPitch = isNaN(pp) ? undefined : pp;
      if (!isNaN(fl) && fl > 0 && !isNaN(pp) && pp > 0) {
         var ps = (206.265 * pp) / fl;
         dialog.scaleInfoLabel.text = format("(%.2f arcsec/px)", ps);
         dialog.execButton.enabled = true;
      } else {
         dialog.scaleInfoLabel.text = "";
         dialog.execButton.enabled = false;
      }
   };

   this.focalLengthEdit.onTextUpdated = function () {
      updateScaleAndButton();
   };
   this.pixelPitchEdit.onTextUpdated = function () {
      updateScaleAndButton();
   };

   coordGroup.sizer = new VerticalSizer;
   coordGroup.sizer.margin = 6;
   coordGroup.sizer.spacing = 4;
   coordGroup.sizer.add(objSizer);
   coordGroup.sizer.add(raSizer);
   coordGroup.sizer.add(decSizer);
   coordGroup.sizer.add(flSizer);
   coordGroup.sizer.add(ppSizer);

   //--- Settings button ---
   this.settingsButton = new PushButton(this);
   this.settingsButton.text = "Settings...";
   this.settingsButton.icon = this.scaledResource(":/icons/wrench.png");
   this.settingsButton.toolTip = "Configure Python environment";
   this.settingsButton.onClick = function () {
      var dlg = new SettingsDialog(params);
      if (dlg.execute()) {
         params.save();
      }
   };

   //--- Buttons ---
   this.execButton = new PushButton(this);
   this.execButton.text = "Execute";
   this.execButton.icon = this.scaledResource(":/icons/power.png");
   this.execButton.onClick = function () {
      this.dialog.ok();
   };

   // Focal length と Pixel pitch が両方入力されている場合のみ Execute を有効化
   updateScaleAndButton();

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.icon = this.scaledResource(":/icons/cancel.png");
   this.cancelButton.onClick = function () {
      this.dialog.cancel();
   };

   var buttonSizer = new HorizontalSizer;
   buttonSizer.spacing = 8;
   buttonSizer.add(this.settingsButton);
   buttonSizer.addStretch();
   buttonSizer.add(this.execButton);
   buttonSizer.add(this.cancelButton);

   //--- Layout ---
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add(infoGroup);
   this.sizer.add(gridGroup);
   this.sizer.add(coordGroup);
   this.sizer.addSpacing(4);
   this.sizer.add(buttonSizer);

   this.adjustToContents();
}

ParameterDialog.prototype = new Dialog;

//============================================================================
//main() - エントリーポイント
//============================================================================
function main() {
   console.show();
   console.writeln("<b>" + TITLE + " v" + VERSION + "</b>");
   console.writeln("================================");

   //1. 保存済み設定を読み込み
   var params = new SolverParameters;
   params.load();

   //2. アクティブなImageWindowを取得
   var window = ImageWindow.activeWindow;
   if (window.isNull) {
      var mb = new MessageBox(
         "No active image window.\nPlease open an image first.",
         TITLE, StdIcon_Error, StdButton_Ok);
      mb.execute();
      return;
   }

   //3. 画像情報を表示
   var filePath = window.filePath;
   if (filePath.length > 0) {
      console.writeln("Image: " + filePath);
   } else {
      console.writeln("Image: (unsaved)");
   }
   console.writeln(format("Size: %d x %d", window.mainView.image.width,
      window.mainView.image.height));

   //4. 環境設定が未設定なら設定ダイアログを表示
   if (!params.isConfigured()) {
      console.writeln("Python environment not configured. Opening settings...");
      var settingsDlg = new SettingsDialog(params);
      if (!settingsDlg.execute()) {
         console.writeln("Setup cancelled by user.");
         return;
      }
      params.save();
   }

   //5. FITSキーワードからメタデータを自動取得
   var engine = new SolverEngine;
   var metadata = engine.extractMetadataFromWindow(window);

   if (metadata.ra !== undefined) {
      console.writeln(format("Auto-detected RA: %s (%.4f\u00B0)", degreesToHMS(metadata.ra), metadata.ra));
      params.ra = metadata.ra;
   }
   if (metadata.dec !== undefined) {
      console.writeln(format("Auto-detected DEC: %s (%.4f\u00B0)", degreesToDMS(metadata.dec), metadata.dec));
      params.dec = metadata.dec;
   }
   if (metadata.focalLength !== undefined) {
      console.writeln(format("Auto-detected focal length: %.1f mm", metadata.focalLength));
      params.focalLength = metadata.focalLength;
   }
   if (metadata.pixelSize !== undefined) {
      console.writeln(format("Auto-detected pixel pitch: %.2f \u00B5m", metadata.pixelSize));
      params.pixelPitch = metadata.pixelSize;
   }

   //6. パラメータダイアログ表示
   var windowInfo = {
      name: window.mainView.id,
      width: window.mainView.image.width,
      height: window.mainView.image.height
   };

   var paramDlg = new ParameterDialog(params, windowInfo);
   if (!paramDlg.execute()) {
      console.writeln("Cancelled by user.");
      return;
   }

   //7. 設定を保存
   params.save();

   //8. 現在のビュー状態を一時ファイルに保存してPython main.pyを実行
   console.writeln("");
   console.writeln("<b>Starting solver...</b>");
   console.flush();

   // 一時ファイルパスを生成
   var tmpInput = File.systemTempDirectory + "/split_solver_input.xisf";
   var tmpOutput = File.systemTempDirectory + "/split_solver_output.xisf";

   try {
      // 現在のビュー状態（編集中のピクセルデータ含む）を一時XISFに保存
      // FileFormatInstanceを使い、window.filePathを変えないようにする
      console.writeln("Saving current view to temporary file...");
      if (File.exists(tmpInput)) File.remove(tmpInput);

      var xisfFormat = new FileFormat("XISF", false/*toRead*/, true/*toWrite*/);
      var writer = new FileFormatInstance(xisfFormat);
      if (!writer.create(tmpInput))
         throw new Error("Failed to create temp file: " + tmpInput);
      // FITSキーワードをコピー（メタデータ保持のため）
      writer.keywords = window.keywords;
      var imgDesc = new ImageDescription;
      imgDesc.bitsPerSample = 32;
      imgDesc.ieeefpSampleFormat = true;
      if (!writer.setOptions(imgDesc))
         throw new Error("Failed to set image options for temp file");
      if (!writer.writeImage(window.mainView.image))
         throw new Error("Failed to write image data to temp file");
      writer.close();
      console.writeln("Saved: " + tmpInput);

      var result = engine.execute(tmpInput, tmpOutput, params);

      if (result.success) {
         //9. 成功時: WCSキーワードをアクティブウィンドウに直接適用
         console.writeln("");
         console.writeln("<b>Solver completed successfully!</b>");
         console.writeln("Applying WCS keywords to active window...");

         if (result.wcs_keywords) {
            // 既存キーワードからWCS関連を除去
            var existingKw = window.keywords;
            var cleanedKw = [];
            for (var i = 0; i < existingKw.length; i++) {
               if (!isWCSKeyword(existingKw[i].name)) {
                  cleanedKw.push(existingKw[i]);
               }
            }

            // 新しいWCSキーワードを追加
            var wcsKeys = result.wcs_keywords;
            var addedCount = 0;
            for (var key in wcsKeys) {
               if (wcsKeys.hasOwnProperty(key)) {
                  cleanedKw.push(makeFITSKeyword(key, wcsKeys[key]));
                  addedCount++;
               }
            }

            window.keywords = cleanedKw;
            console.writeln(format("Added %d WCS keywords.", addedCount));

            // アストロメトリックソリューション表示を再生成
            window.regenerateAstrometricSolution();
            console.writeln("Astrometric solution applied. View state preserved.");
         } else {
            console.warningln("No WCS keywords in result. Falling back to file reload...");
            // フォールバック: 一時出力ファイルからWCSを読み込み
            if (File.exists(tmpOutput)) {
               var id = window.mainView.id;
               window.forceClose();
               var newWindows = ImageWindow.open(tmpOutput);
               if (newWindows.length > 0) {
                  newWindows[0].show();
                  console.writeln("Image loaded from solver output.");
               } else {
                  console.warningln("Failed to open solver output.");
               }
            }
         }
      }
      else {
         //実行は正常終了したが結果がfalseの場合
         var mb = new MessageBox(
            "Solver completed but reported failure.\n" +
            "Check the console for details.",
            TITLE, StdIcon_Warning, StdButton_Ok);
         mb.execute();
      }
   }
   catch (error) {
      //10. 失敗時
      if (error.message.indexOf("aborted by user") >= 0) {
         // Abort はユーザー操作なのでエラーダイアログは出さない
         console.warningln("Solver aborted by user.");
      } else {
         console.criticalln("Error: " + error.message);
         var mb = new MessageBox(
            "Solver failed:\n\n" + error.message +
            "\n\nCheck the Process Console for details.",
            TITLE, StdIcon_Error, StdButton_Ok);
         mb.execute();
      }
   }
   finally {
      // 一時ファイルのクリーンアップ
      try { if (File.exists(tmpInput)) File.remove(tmpInput); } catch (e) {}
      try { if (File.exists(tmpOutput)) File.remove(tmpOutput); } catch (e) {}
   }

   console.writeln("");
   console.writeln("================================");
   console.writeln(TITLE + " finished.");
}

main();
