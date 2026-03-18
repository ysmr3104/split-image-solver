// hello_automation.js
// automation-mode の動作確認用スクリプト
// 実行: /Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
//         --automation-mode -r="tests/pjsr/hello_automation.js" --force-exit

(function() {
   var outPath = "/Users/ysmr/projects/split-image-solver/tests/pjsr/hello_result.txt";
   var lines = [];
   lines.push("=== automation-mode hello world ===");
   lines.push("jsArguments: " + (typeof jsArguments !== "undefined" ? JSON.stringify(jsArguments) : "(undefined)"));
   lines.push("=== OK ===");

   var f = new File();
   f.createForWriting(outPath);
   f.outTextLn(lines.join("\n"));
   f.close();

   console.writeln(lines.join("\n"));
})();
