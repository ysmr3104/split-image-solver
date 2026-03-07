//============================================================================
// astrometry_api.js - Astrometry.net API Client
//
// HTTP communication via ExternalProcess + curl.
// Pure PJSR implementation (no external dependencies).
//
// Copyright (c) 2026 Split Image Solver Project
//============================================================================

// -------------------------------------------------------------------------
// AstrometryClient constructor
// -------------------------------------------------------------------------
function AstrometryClient(apiKey) {
   this.apiKey = apiKey;
   this.session = null;
   this.apiUrl = "http://nova.astrometry.net/api";
   this.baseUrl = "http://nova.astrometry.net";
   this.pollInterval = 3000; // ms
   this.timeout = 300000;    // 5 min (default, configurable)
   this.aborted = false;
}

// Interruptible sleep: yields to UI every 200ms and checks for abort
// Checks both console.abortRequested and this.abortCheck callback
AstrometryClient.prototype._sleep = function(ms) {
   var step = 200;
   var remaining = ms;
   while (remaining > 0) {
      msleep(Math.min(step, remaining));
      remaining -= step;
      processEvents();
      if (console.abortRequested ||
          (typeof this.abortCheck === "function" && this.abortCheck())) {
         this.aborted = true;
         throw "Aborted by user";
      }
   }
};

// -------------------------------------------------------------------------
// _uniqueTmpPath - generate a unique temporary file path
// -------------------------------------------------------------------------
AstrometryClient.prototype._uniqueTmpPath = function(suffix) {
   var ts = (new Date()).getTime();
   var rand = Math.floor(Math.random() * 100000);
   return File.systemTempDirectory + "/astro_" + ts + "_" + rand + (suffix || ".json");
};

// -------------------------------------------------------------------------
// _curlPost - low-level POST via curl -F (multipart form)
//
// formFields: [{name: "...", value: "..."}]
// filePath:   optional file to upload via -F "file=@path"
// timeoutSec: curl -m timeout in seconds (default 30)
//
// Returns parsed JSON object, or null on error.
// -------------------------------------------------------------------------
AstrometryClient.prototype._curlPost = function(url, formFields, filePath, timeoutSec) {
   var tmpFile = this._uniqueTmpPath();
   var args = ["-s", "-o", tmpFile, "-m", String(timeoutSec || 30)];

   // Build -F arguments
   if (formFields) {
      for (var i = 0; i < formFields.length; i++) {
         args.push("-F");
         args.push(formFields[i].name + "=" + formFields[i].value);
      }
   }
   if (filePath) {
      args.push("-F");
      args.push("file=@" + filePath);
   }
   args.push(url);

   console.writeln("[AstrometryClient] POST " + url);

   var P = new ExternalProcess;
   P.start("curl", args);
   if (!P.waitForFinished(((timeoutSec || 30) + 10) * 1000)) {
      P.kill();
      console.writeln("[AstrometryClient] curl POST timed out");
      return null;
   }
   if (P.exitCode !== 0) {
      console.writeln("[AstrometryClient] curl POST failed, exit code: " + P.exitCode);
      return null;
   }
   if (!File.exists(tmpFile)) {
      console.writeln("[AstrometryClient] curl POST: no output file");
      return null;
   }

   var content = "";
   try {
      content = File.readTextFile(tmpFile);
      File.remove(tmpFile);
   } catch (e) {
      console.writeln("[AstrometryClient] failed to read response: " + e.message);
      return null;
   }

   try {
      return JSON.parse(content);
   } catch (e) {
      console.writeln("[AstrometryClient] JSON parse error: " + e.message);
      console.writeln("[AstrometryClient] raw response: " + content.substring(0, 500));
      return null;
   }
};

// -------------------------------------------------------------------------
// _curlGet - GET request, returns response text or null
// -------------------------------------------------------------------------
AstrometryClient.prototype._curlGet = function(url, timeoutSec) {
   var tmpFile = this._uniqueTmpPath(".txt");
   var args = ["-s", "-o", tmpFile, "-m", String(timeoutSec || 30), url];

   var P = new ExternalProcess;
   P.start("curl", args);
   if (!P.waitForFinished(((timeoutSec || 30) + 10) * 1000)) {
      P.kill();
      console.writeln("[AstrometryClient] curl GET timed out: " + url);
      return null;
   }
   if (P.exitCode !== 0) {
      console.writeln("[AstrometryClient] curl GET failed, exit code: " + P.exitCode);
      return null;
   }
   if (!File.exists(tmpFile)) {
      return null;
   }

   var content = "";
   try {
      content = File.readTextFile(tmpFile);
      File.remove(tmpFile);
   } catch (e) {
      console.writeln("[AstrometryClient] failed to read GET response: " + e.message);
      return null;
   }
   return content;
};

// -------------------------------------------------------------------------
// _curlGetJson - GET request, returns parsed JSON or null
// -------------------------------------------------------------------------
AstrometryClient.prototype._curlGetJson = function(url, timeoutSec) {
   var text = this._curlGet(url, timeoutSec);
   if (text === null) return null;

   try {
      return JSON.parse(text);
   } catch (e) {
      console.writeln("[AstrometryClient] JSON parse error (GET): " + e.message);
      console.writeln("[AstrometryClient] raw: " + text.substring(0, 500));
      return null;
   }
};

// -------------------------------------------------------------------------
// _curlGetBinary - download binary file to outputPath
// Returns true on success.
// -------------------------------------------------------------------------
AstrometryClient.prototype._curlGetBinary = function(url, outputPath, timeoutSec) {
   var args = ["-s", "-o", outputPath, "-m", String(timeoutSec || 30), url];

   console.writeln("[AstrometryClient] downloading: " + url);

   var P = new ExternalProcess;
   P.start("curl", args);
   if (!P.waitForFinished(((timeoutSec || 30) + 10) * 1000)) {
      P.kill();
      console.writeln("[AstrometryClient] binary download timed out");
      return false;
   }
   if (P.exitCode !== 0) {
      console.writeln("[AstrometryClient] binary download failed, exit code: " + P.exitCode);
      return false;
   }
   return File.exists(outputPath);
};

// -------------------------------------------------------------------------
// login - POST /api/login
// Returns true on success, false on failure.
// -------------------------------------------------------------------------
AstrometryClient.prototype.login = function() {
   var requestJson = JSON.stringify({ apikey: this.apiKey });
   var formFields = [{ name: "request-json", value: requestJson }];

   var result = this._curlPost(this.apiUrl + "/login", formFields);
   if (!result) {
      console.writeln("[AstrometryClient] login: no response");
      return false;
   }
   if (result.status !== "success") {
      console.writeln("[AstrometryClient] login failed: " + JSON.stringify(result));
      return false;
   }

   this.session = result.session;
   console.writeln("[AstrometryClient] login successful");
   return true;
};

// -------------------------------------------------------------------------
// upload - POST /api/upload
//
// filePath: path to the image file
// hints:    optional object with fields:
//   scale_units, scale_est, scale_err, center_ra, center_dec,
//   radius, downsample_factor, tweak_order
//
// Returns subid (number) on success, null on failure.
// -------------------------------------------------------------------------
AstrometryClient.prototype.upload = function(filePath, hints) {
   if (!this.session) {
      console.writeln("[AstrometryClient] upload: not logged in");
      return null;
   }

   var requestObj = { session: this.session };

   // Merge hint fields if provided
   if (hints) {
      var hintKeys = [
         "scale_units", "scale_est", "scale_err",
         "center_ra", "center_dec", "radius",
         "downsample_factor", "tweak_order"
      ];
      for (var i = 0; i < hintKeys.length; i++) {
         var key = hintKeys[i];
         if (hints.hasOwnProperty(key) && hints[key] !== undefined && hints[key] !== null) {
            requestObj[key] = hints[key];
         }
      }
   }

   var requestJson = JSON.stringify(requestObj);
   var formFields = [{ name: "request-json", value: requestJson }];

   console.writeln("[AstrometryClient] uploading: " + filePath);
   // Log hints without session key
   var logObj = {};
   for (var k in requestObj) {
      if (requestObj.hasOwnProperty(k) && k !== "session") logObj[k] = requestObj[k];
   }
   console.writeln("[AstrometryClient] hints: " + JSON.stringify(logObj));

   var result = this._curlPost(this.apiUrl + "/upload", formFields, filePath, 120);
   if (!result) {
      console.writeln("[AstrometryClient] upload: no response");
      return null;
   }
   if (result.status !== "success") {
      console.writeln("[AstrometryClient] upload failed: " + JSON.stringify(result));
      return null;
   }

   console.writeln("[AstrometryClient] upload successful, subid: " + result.subid);
   return result.subid;
};

// -------------------------------------------------------------------------
// pollSubmission - GET /api/submissions/{subId}
// Polls until a non-null job_id appears in the jobs array.
// Returns job_id (number) or null on timeout.
// -------------------------------------------------------------------------
AstrometryClient.prototype.pollSubmission = function(subId) {
   var elapsed = 0;
   console.writeln("[AstrometryClient] polling submission " + subId + " ...");

   while (elapsed < this.timeout) {
      var result = this._curlGetJson(this.apiUrl + "/submissions/" + subId);
      if (result && result.jobs && result.jobs.length > 0) {
         for (var i = 0; i < result.jobs.length; i++) {
            if (result.jobs[i] !== null) {
               console.writeln("[AstrometryClient] got job_id: " + result.jobs[i]);
               return result.jobs[i];
            }
         }
      }
      this._sleep(this.pollInterval);
      elapsed += this.pollInterval;
   }

   console.writeln("[AstrometryClient] pollSubmission timed out after " + (this.timeout / 1000) + "s");
   return null;
};

// -------------------------------------------------------------------------
// pollJob - GET /api/jobs/{jobId}
// Polls until job status is "success" or "failure".
// Returns "success", "failure", or null on timeout.
// -------------------------------------------------------------------------
AstrometryClient.prototype.pollJob = function(jobId) {
   var elapsed = 0;
   console.writeln("[AstrometryClient] polling job " + jobId + " ...");

   while (elapsed < this.timeout) {
      var result = this._curlGetJson(this.apiUrl + "/jobs/" + jobId);
      if (result && result.status) {
         if (result.status === "success" || result.status === "failure") {
            console.writeln("[AstrometryClient] job " + jobId + " status: " + result.status);
            return result.status;
         }
      }
      this._sleep(this.pollInterval);
      elapsed += this.pollInterval;
   }

   console.writeln("[AstrometryClient] pollJob timed out after " + (this.timeout / 1000) + "s");
   return null;
};

// -------------------------------------------------------------------------
// getCalibration - GET /api/jobs/{jobId}/calibration/
// Returns calibration object: {ra, dec, radius, pixscale, orientation, parity, ...}
// or null on error.
// -------------------------------------------------------------------------
AstrometryClient.prototype.getCalibration = function(jobId) {
   var result = this._curlGetJson(this.apiUrl + "/jobs/" + jobId + "/calibration/");
   if (!result) {
      console.writeln("[AstrometryClient] getCalibration: no response");
      return null;
   }
   console.writeln("[AstrometryClient] calibration: ra=" + result.ra +
                   " dec=" + result.dec + " pixscale=" + result.pixscale);
   return result;
};

// -------------------------------------------------------------------------
// getWcsFile - download WCS FITS file
// Note: URL is /wcs_file/{jobId} (no /api/ prefix)
// Returns true on success.
// -------------------------------------------------------------------------
AstrometryClient.prototype.getWcsFile = function(jobId, outputPath) {
   var url = this.baseUrl + "/wcs_file/" + jobId;
   return this._curlGetBinary(url, outputPath, 30);
};

// -------------------------------------------------------------------------
// solve - high-level method: login -> upload -> poll -> results
//
// filePath:         path to the image file
// hints:            optional hints object (see upload())
// progressCallback: optional function(message) for status updates
//
// Returns {calibration: {...}, wcsFilePath: "..."} on success, null on failure.
// -------------------------------------------------------------------------
AstrometryClient.prototype.solve = function(filePath, hints, progressCallback) {
   var notify = progressCallback || function() {};

   // Step 1: Login
   notify("Logging in to astrometry.net ...");
   if (!this.login()) {
      notify("Login failed.");
      return null;
   }

   // Step 2: Upload
   notify("Uploading image ...");
   var subId = this.upload(filePath, hints);
   if (subId === null) {
      notify("Upload failed.");
      return null;
   }
   notify("Upload successful. Submission ID: " + subId);

   // Step 3: Wait for job assignment
   notify("Waiting for job assignment ...");
   var jobId = this.pollSubmission(subId);
   if (jobId === null) {
      notify("Timed out waiting for job assignment.");
      return null;
   }
   notify("Job assigned. Job ID: " + jobId);

   // Step 4: Wait for solve completion
   notify("Solving ... (this may take a few minutes)");
   var status = this.pollJob(jobId);
   if (status === null) {
      notify("Timed out waiting for solve.");
      return null;
   }
   if (status === "failure") {
      notify("Solve failed. The image could not be plate-solved.");
      return null;
   }
   notify("Solve successful!");

   // Step 5: Get calibration
   notify("Retrieving calibration data ...");
   var calibration = this.getCalibration(jobId);

   // Step 6: Download WCS file
   var wcsFilePath = File.systemTempDirectory + "/astrometry_wcs_" + jobId + ".fits";
   notify("Downloading WCS FITS file ...");
   var ok = this.getWcsFile(jobId, wcsFilePath);
   if (!ok) {
      console.writeln("[AstrometryClient] WCS file download failed, continuing with calibration only");
      wcsFilePath = null;
   }

   notify("Done.");
   return {
      calibration: calibration,
      wcsFilePath: wcsFilePath,
      jobId: jobId
   };
};
