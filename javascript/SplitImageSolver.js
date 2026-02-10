//----------------------------------------------------------------------------
//SplitImageSolver.js - PixInsight JavaScript Runtime (PJSR) Script
//
//Split Image Solver: 広角星空画像を分割してプレートソルブし、
//統合したWCS情報を元画像に書き込むPixInsightスクリプト
//
//Copyright (c) 2024-2025 Split Image Solver Project
//----------------------------------------------------------------------------

#feature - id    SplitImageSolver: Utilities > SplitImageSolver
#feature - info  広角星空画像を分割プレートソルブしWCSを統合します。\
Pythonバックエンドでastrometry.netのsolve - fieldを並列実行し、\
分割タイルのWCS情報を統合して元画像に書き込みます。

#define VERSION "1.0.0"

#include < pjsr / DataType.jsh >
   #include < pjsr / StdIcon.jsh >
   #include < pjsr / StdButton.jsh >
   #include < pjsr / TextAlign.jsh >
   #include < pjsr / Sizer.jsh >
   #include < pjsr / FrameStyle.jsh >
   #include < pjsr / NumericControl.jsh >
   // --- Helper Functions ---
   function byteArrayToString(ba) {
      var s = "";
      for (var i = 0; i < ba.length; ++i)
         s += String.fromCharCode(ba.at(i));
      return s;
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
   this.pixelScale = undefined;

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
   this.buildCommand = function (inputPath, params) {
      var scriptPath = params.scriptDir + "/python/main.py";

      var args = [
         params.pythonPath,
         scriptPath,
         "--input", inputPath,
         "--output", inputPath,    //上書きモード
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
      if (params.pixelScale !== undefined && params.pixelScale !== null) {
         args.push("--pixel-scale");
         args.push(params.pixelScale.toString());
      }

      return args;
   };

   //Python main.pyを実行
   this.execute = function (inputPath, params) {
      var args = this.buildCommand(inputPath, params);

      console.writeln("<b>Split Image Solver: Executing...</b>");
      console.writeln("Command: " + args.join(" "));
      console.flush();

      var P = new ExternalProcess;

      //作業ディレクトリをスクリプトディレクトリに設定
      P.workingDirectory = params.scriptDir;

      //プログラムと引数を設定
      var program = args[0];
      var processArgs = args.slice(1);

      P.start(program, processArgs);

      //完了まで待機（タイムアウト: 30分）
      var timeoutMs = 30 * 60 * 1000;
      if (!P.waitForFinished(timeoutMs)) {
         P.kill();
         throw new Error("Process timed out after 30 minutes");
      }

      //stdout/stderrをコンソールに出力
      console.writeln("Stdout size: " + P.stdout.length + " bytes");
      console.writeln("Stderr size: " + P.stderr.length + " bytes");

      var stdout = byteArrayToString(P.stdout).trim();
      var stderr = byteArrayToString(P.stderr).trim();

      if (stderr.length > 0) {
         //stderrにはPythonのログ出力が含まれる
         var lines = stderr.split("\n");
         for (var i = 0; i < lines.length; i++)
            console.writeln("<span style='color: #ff6666;'>[PYTHON] " + lines[i] + "</span>");
      }

      //終了コードチェック
      if (P.exitCode !== 0) {
         console.warningln("Process exited with code: " + P.exitCode);
         //stdoutにJSON出力があるか試行
         if (stdout.length > 0) {
            try {
               var result = JSON.parse(stdout);
               if (result.error)
                  throw new Error("Solver failed: " + result.error);
            }
            catch (e) {
               if (e.message.indexOf("Solver failed") === 0)
                  throw e;
            }
         }
         throw new Error("Solver process exited with code " + P.exitCode);
      }

      //JSON結果をパース
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
   coordGroup.title = "Coordinate Hints (auto-detected)";

   var raLabel = new Label(coordGroup);
   raLabel.text = "RA:";
   raLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   raLabel.setFixedWidth(120);

   this.raEdit = new Edit(coordGroup);
   this.raEdit.text = (params.ra !== undefined && params.ra !== null)
      ? params.ra.toFixed(4) : "";
   this.raEdit.toolTip = "Right Ascension in degrees (optional)";
   this.raEdit.setFixedWidth(120);
   this.raEdit.onTextUpdated = function () {
      var v = parseFloat(this.dialog.raEdit.text);
      params.ra = isNaN(v) ? undefined : v;
   };

   var raUnitLabel = new Label(coordGroup);
   raUnitLabel.text = "deg";

   var raSizer = new HorizontalSizer;
   raSizer.spacing = 4;
   raSizer.add(raLabel);
   raSizer.add(this.raEdit);
   raSizer.add(raUnitLabel);
   raSizer.addStretch();

   var decLabel = new Label(coordGroup);
   decLabel.text = "DEC:";
   decLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   decLabel.setFixedWidth(120);

   this.decEdit = new Edit(coordGroup);
   this.decEdit.text = (params.dec !== undefined && params.dec !== null)
      ? params.dec.toFixed(4) : "";
   this.decEdit.toolTip = "Declination in degrees (optional)";
   this.decEdit.setFixedWidth(120);
   this.decEdit.onTextUpdated = function () {
      var v = parseFloat(this.dialog.decEdit.text);
      params.dec = isNaN(v) ? undefined : v;
   };

   var decUnitLabel = new Label(coordGroup);
   decUnitLabel.text = "deg";

   var decSizer = new HorizontalSizer;
   decSizer.spacing = 4;
   decSizer.add(decLabel);
   decSizer.add(this.decEdit);
   decSizer.add(decUnitLabel);
   decSizer.addStretch();

   var scaleLabel = new Label(coordGroup);
   scaleLabel.text = "Pixel scale:";
   scaleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   scaleLabel.setFixedWidth(120);

   this.scaleEdit = new Edit(coordGroup);
   this.scaleEdit.text = (params.pixelScale !== undefined && params.pixelScale !== null)
      ? params.pixelScale.toFixed(2) : "";
   this.scaleEdit.toolTip = "Pixel scale in arcseconds per pixel (optional)";
   this.scaleEdit.setFixedWidth(120);
   this.scaleEdit.onTextUpdated = function () {
      var v = parseFloat(this.dialog.scaleEdit.text);
      params.pixelScale = isNaN(v) ? undefined : v;
   };

   var scaleUnitLabel = new Label(coordGroup);
   scaleUnitLabel.text = "arcsec/px";

   var scaleSizer = new HorizontalSizer;
   scaleSizer.spacing = 4;
   scaleSizer.add(scaleLabel);
   scaleSizer.add(this.scaleEdit);
   scaleSizer.add(scaleUnitLabel);
   scaleSizer.addStretch();

   coordGroup.sizer = new VerticalSizer;
   coordGroup.sizer.margin = 6;
   coordGroup.sizer.spacing = 4;
   coordGroup.sizer.add(raSizer);
   coordGroup.sizer.add(decSizer);
   coordGroup.sizer.add(scaleSizer);

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

   //3. ファイルパスを取得
   var filePath = window.filePath;
   if (filePath.length === 0) {
      var mb = new MessageBox(
         "The active image has not been saved to disk.\n" +
         "Please save the image first (File> Save As).",
         TITLE, StdIcon_Error, StdButton_Ok);
      mb.execute();
      return;
   }

   console.writeln("Image: " + filePath);
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
      console.writeln(format("Auto-detected RA: %.4f deg", metadata.ra));
      params.ra = metadata.ra;
   }
   if (metadata.dec !== undefined) {
      console.writeln(format("Auto-detected DEC: %.4f deg", metadata.dec));
      params.dec = metadata.dec;
   }
   if (metadata.pixelScale !== undefined) {
      console.writeln(format("Auto-detected pixel scale: %.2f arcsec/px", metadata.pixelScale));
      params.pixelScale = metadata.pixelScale;
   }
   if (metadata.focalLength !== undefined)
      console.writeln(format("Auto-detected focal length: %.1f mm", metadata.focalLength));

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

   //8. Python main.pyを実行
   console.writeln("");
   console.writeln("<b>Starting solver...</b>");
   console.flush();

   try {
      var result = engine.execute(filePath, params);

      if (result.success) {
         //9. 成功時: 画像を再読み込み
         console.writeln("");
         console.writeln("<b>Solver completed successfully!</b>");
         console.writeln("Reloading image...");

         //現在のウィンドウを閉じて再度開く
         var id = window.mainView.id;
         window.forceClose();

         var newWindows = ImageWindow.open(filePath);
         if (newWindows.length > 0) {
            newWindows[0].show();
            console.writeln("Image reloaded with WCS information.");
         }
         else {
            console.warningln("Failed to reopen image. Please open manually: " + filePath);
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
      //10. 失敗時: エラーダイアログ
      console.criticalln("Error: " + error.message);
      var mb = new MessageBox(
         "Solver failed:\n\n" + error.message +
         "\n\nCheck the Process Console for details.",
         TITLE, StdIcon_Error, StdButton_Ok);
      mb.execute();
   }

   console.writeln("");
   console.writeln("================================");
   console.writeln(TITLE + " finished.");
}

main();
