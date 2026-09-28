var express = require('express');
var path = require('path');
var fs = require('fs');
var dotenv = require('dotenv');
var execFile = require('child_process').execFile;
var router = express.Router();

// process.cwd() rather than __dirname: `npm run build` (see build.js at the repo root) bundles
// this file's code together with app.js (and the other routes/*.js files) into a single output
// file whose __dirname, at runtime, is wherever that bundled file physically lands — not this
// source file's original `routes/` directory. This file's own paths assumed exactly one level of
// nesting under the repo root (`path.join(__dirname, '..', ...)`), which silently breaks once
// merged into a bundle that isn't nested that same one level deep (e.g. a flattened, root-level
// bundle file would resolve '..' one level too far, looking for scripts/ and .env *outside* the
// deployed dist/ folder entirely). process.cwd() has no such dependency on how deeply nested the
// bundled file ends up — it works identically for the unbundled source (`npm start`, always run
// from the repo root — see CLAUDE.md) and the bundled dist/ output (expected to be started from
// its own root the same way).
var APP_ROOT = process.cwd();
var ENV_PATH = path.join(APP_ROOT, '.env');

// Reads the CURRENT JOBUP_EMAIL/JOBUP_PASSWORD straight from the .env file on disk — not from this
// process's own `process.env`, which dotenv only populated once, at server startup, via app.js's
// `require('dotenv').config()`. scripts/jobup-login.js rewrites that file in place on a successful
// login (see its own comment), and every POST /cv-match spawns a brand-new child process, so
// re-reading the file fresh on every request here is what lets a freshly-entered login take effect
// immediately, with no backend restart needed. Falls back to this process's own process.env (what
// dotenv loaded at startup) if the file is missing or unreadable.
function readCurrentJobupCredentials() {
  try {
    var parsed = dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
    return {
      JOBUP_EMAIL: parsed.JOBUP_EMAIL || process.env.JOBUP_EMAIL,
      JOBUP_PASSWORD: parsed.JOBUP_PASSWORD || process.env.JOBUP_PASSWORD
    };
  } catch (err) {
    return { JOBUP_EMAIL: process.env.JOBUP_EMAIL, JOBUP_PASSWORD: process.env.JOBUP_PASSWORD };
  }
}

// Tracks the single currently-running /cv-match child process (this app's UI only ever lets one
// analysis run at a time — the CV Analysis button disables while pending — so a single module-level
// slot is enough) so POST /cv-match/stop has something to kill. `{ process, stoppedByUser }` while
// one is running, `null` otherwise. `stoppedByUser` distinguishes an explicit user-requested stop
// from execFile's own `timeout` option killing a run that simply took too long (180s) — both look
// identical to Node (the process was killed) but only the former should be reported to the frontend
// as "Analysis stopped by user." instead of the generic failure the timeout case already produced.
var runningCvMatch = null;

// On Windows, taskkill's /T (tree) /F (force) flags are the only reliable way to take down both
// this node process AND anything IT spawned (e.g. the Playwright-launched Chromium browser) —
// Windows has no POSIX process-group signal for child_process to target directly.
//
// Confirmed live (an earlier version of this function called child.kill() first, before taskkill,
// specifically to mark the ChildProcess as killed for detection purposes): that raced against
// taskkill and defeated it. child.kill() terminates the node process almost immediately (Windows
// TerminateProcess), and by the time the async taskkill call actually reached the OS, that PID no
// longer existed for taskkill to find at all (`Erreur : le processus "<pid>" est introuvable`) —
// which meant /T never got a chance to walk its still-alive-at-that-point child tree, so the
// browser subprocess was silently left orphaned even though the analysis appeared to stop cleanly.
// The `err.killed`-marking purpose child.kill() originally served here was made obsolete anyway
// once `stoppedByUser` (set below, in the /cv-match/stop handler) became the actual signal the
// /cv-match callback uses to detect a user-requested stop — so it's dropped entirely here rather
// than reordered, and taskkill alone (while the process tree is still alive) does the real killing.
function killProcessTree(child) {
  if (!child || child.pid == null) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], function(killErr) {
      if (killErr) {
        console.error('[jobup-cv-match] taskkill for pid ' + child.pid + ' (stop cleanup):', killErr.message);
      }
    });
  } else {
    child.kill('SIGTERM');
  }
}

/* GET backend health status, used by the Angular frontend to verify connectivity. */
router.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'express-backend', timestamp: new Date().toISOString() });
});

/*
 * POST triggers the jobup.ch login automation as a background process (see
 * scripts/jobup-login.js), waits for it to finish, and reports the outcome as a display string.
 * Takes `email`/`password` in the body, from the frontend's Email/Password inputs next to the
 * Login button (native `type="email"`/`required` HTML validators on those fields keep an empty or
 * malformed value from ever reaching this endpoint in the first place) — passed to the script via
 * its spawned environment, overriding whatever this server process's own JOBUP_EMAIL/JOBUP_PASSWORD
 * currently are, so each attempt uses exactly what the user just typed rather than a stale value.
 * On success, scripts/jobup-login.js itself rewrites the .env file with these same credentials (see
 * its own comment for how) so subsequent POST /cv-match runs pick them up too, via
 * readCurrentJobupCredentials() above — no server restart needed; on failure, .env is left
 * completely untouched.
 * `message` is `'Login succeeded !'` on success, else the script's own `errorMessage` when it's a
 * specific, known failure (a `LoginValidationError` subclass in scripts/jobup-login.js —
 * currently `'Invalid login credentials'`, when jobup.ch itself rejected the email/password, or
 * `'Invalid email format'`, when Auth0's own client-side validator rejected the typed email) — or
 * the generic `'Login failed !'` for anything else (a genuinely unexpected error, or the email/
 * password missing from the request body).
 */
router.post('/login', function(req, res) {
  var scriptPath = path.join(APP_ROOT, 'scripts', 'jobup-login.js');
  var email = (req.body && typeof req.body.email === 'string') ? req.body.email.trim() : '';
  var password = (req.body && typeof req.body.password === 'string') ? req.body.password : '';

  if (!email || !password) {
    return res.json({ success: false, message: 'Login failed !' });
  }

  execFile(
    'node',
    [scriptPath],
    {
      timeout: 60000,
      env: Object.assign({}, process.env, { JOBUP_EMAIL: email, JOBUP_PASSWORD: password })
    },
    function(err, stdout, stderr) {
      if (stderr) {
        console.error('[jobup-login]', stderr.trim());
      }

      var success = false;
      var errorMessage = null;
      try {
        var parsed = JSON.parse(stdout.trim());
        success = !!parsed.success;
        errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
      } catch (parseErr) {
        console.error('[jobup-login] could not parse script output:', stdout);
      }

      res.json({ success: success, message: success ? 'Login succeeded !' : (errorMessage || 'Login failed !') });
    }
  );
});

/*
 * POST triggers the jobup.ch job-search + CV-match automation as a background process (see
 * scripts/jobup-cv-match.js), waits for it to finish, and reports
 * { success, analysis, meter, criteria, jobUrl, totalJobsCount } (the script also POSTs that same
 * data to /cv-analysis itself before it exits). Takes a 1-based `jobIndex` in the body selecting
 * which job to analyze (defaults to 1); the script itself validates it against the actual result
 * count. Also takes a boolean `useBasicSearch` (defaults to false): when true, the script skips the
 * profile-based CTA and goes straight to the "Recherche d'emploi" sub-nav / basic-search entry
 * point; when false, it tries the CTA first and only falls back to basic search if unavailable.
 * `meter` ({ color: 'green'|'yellow'|null, percent: number|null }) and `criteria`
 * ([{ text, status: 'green'|'yellow'|'gray' }]) come straight from the analysis modal's DOM (icon/
 * fill color, not text) — see scripts/jobup-cv-match.js's extractAnalysisStructure(). `errorMessage`
 * is non-null only for a specific, expected failure — jobup.ch itself reporting 0 matching jobs for
 * the given search term/locations (see waitForJobResults()'s EmptyResultsError in that script) —
 * and is meant to be shown to the user as-is instead of a generic "Analysis failed !" message.
 * `resultsUrl` is the search results *listing* page's own URL (term/location/page=N query params,
 * distinct from `jobUrl`, the individual job's detail URL) — present whenever the script actually
 * reached a results page, even on a failure (invalid/out-of-range jobIndex, 0 results), and `null`
 * only when the run failed before any search ran (e.g. login failure). `applicationUrl` is the
 * opened draft application page's own URL (see `easyApply` below) — `null` whenever no draft page
 * was ever opened (easyApply off, no meter, no applicable button on the job, an error, etc.).
 * Also takes `searchTerm` (string) and `locations` (string[]) to customize the job search: both
 * are trimmed (and truncated to 255 chars) here, empty/blank entries dropped from `locations`, and
 * the script falls back to its own RECOVERY_SEARCH_TERM/LOCATION_SLUG defaults for whichever one
 * comes out empty — except `searchTerm`, which the script ignores entirely whenever "Rechercher
 * avec mon profil" ends up being used (that CTA generates its own profile-derived term).
 * Also takes three more booleans (all default false), passed straight through to the script and
 * ignored there entirely whenever `meter` comes back null (the "Vos talents correspondent mieux à
 * d'autres opportunités" no-meter case): `saveJob` (click "Sauvegarder" to save the job),
 * `easyApply` (open "Candidature simplifiée"/"Continuer ma candidature" and prepare, but never
 * submit, a draft application there), and `ignoreYellowMeter` (when true, additionally skip both
 * of the above for a yellow meter specifically — only green then qualifies; when false, green and
 * yellow are treated the same).
 * The spawned child process is tracked in `runningCvMatch` for the duration of the run, so
 * POST /cv-match/stop (below) can kill it early; if that happens, `errorMessage` here comes back as
 * 'Analysis stopped by user.' instead of whatever the script itself would have reported.
 * JOBUP_EMAIL/JOBUP_PASSWORD are supplied to the spawned environment via
 * readCurrentJobupCredentials() (see its comment) — always the *current* contents of the .env file,
 * not whatever this server process's own process.env held at startup — so a login submitted through
 * POST /login after the server started is picked up by the very next analysis with no restart.
 */
router.post('/cv-match', function(req, res) {
  var scriptPath = path.join(APP_ROOT, 'scripts', 'jobup-cv-match.js');
  var jobIndex = Number(req.body && req.body.jobIndex);
  if (!Number.isFinite(jobIndex)) {
    jobIndex = 1;
  }
  var useBasicSearch = !!(req.body && req.body.useBasicSearch);
  var searchTerm = (req.body && typeof req.body.searchTerm === 'string')
    ? req.body.searchTerm.trim().slice(0, 255)
    : '';
  var locations = (req.body && Array.isArray(req.body.locations))
    ? req.body.locations
        .filter(function(location) { return typeof location === 'string' && location.trim(); })
        .map(function(location) { return location.trim().slice(0, 255); })
    : [];
  var saveJob = !!(req.body && req.body.saveJob);
  var easyApply = !!(req.body && req.body.easyApply);
  var ignoreYellowMeter = !!(req.body && req.body.ignoreYellowMeter);

  var current = { process: null, stoppedByUser: false };

  var child = execFile(
    'node',
    [
      scriptPath,
      String(jobIndex),
      String(useBasicSearch),
      searchTerm,
      JSON.stringify(locations),
      String(saveJob),
      String(easyApply),
      String(ignoreYellowMeter)
    ],
    {
      timeout: 180000,
      env: Object.assign({}, process.env, readCurrentJobupCredentials())
    },
    function(err, stdout, stderr) {
      if (runningCvMatch === current) {
        runningCvMatch = null;
      }
      if (stderr) {
        console.error('[jobup-cv-match]', stderr.trim());
      }

      var wasStopped = current.stoppedByUser;
      if (wasStopped) {
        console.error('[jobup-cv-match] analysis process was stopped by user request.');
      }

      var success = false;
      var analysis = null;
      var meter = null;
      var criteria = [];
      var jobUrl = null;
      var totalJobsCount = null;
      var errorMessage = null;
      var resultsUrl = null;
      var applicationUrl = null;
      try {
        var parsed = JSON.parse(stdout.trim());
        success = !!parsed.success;
        analysis = parsed.analysis || null;
        meter = parsed.meter || null;
        criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
        jobUrl = parsed.jobUrl || null;
        totalJobsCount = typeof parsed.totalJobsCount === 'number' ? parsed.totalJobsCount : null;
        errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
        resultsUrl = typeof parsed.resultsUrl === 'string' ? parsed.resultsUrl : null;
        applicationUrl = typeof parsed.applicationUrl === 'string' ? parsed.applicationUrl : null;
      } catch (parseErr) {
        // Expected whenever the process was killed (stopped or timed out) before it could print
        // its JSON line — every field above just stays at its default in that case.
        if (!wasStopped) {
          console.error('[jobup-cv-match] could not parse script output:', stdout);
        }
      }

      if (res.headersSent || res.writableEnded) {
        // The frontend already unsubscribed (see app.ts's onStopClick()) and its underlying
        // request was cancelled client-side; nothing left to send this response to.
        return;
      }
      res.json({
        success: success,
        analysis: analysis,
        meter: meter,
        criteria: criteria,
        jobUrl: jobUrl,
        totalJobsCount: totalJobsCount,
        errorMessage: wasStopped ? 'Analysis stopped by user.' : errorMessage,
        resultsUrl: resultsUrl,
        applicationUrl: applicationUrl,
      });
    }
  );
  current.process = child;
  runningCvMatch = current;
});

/*
 * POST stops the currently-running /cv-match analysis (see runningCvMatch above), if any — used by
 * the frontend's "Stop analysis" button, which is only enabled while an analysis is pending. Kills
 * the child process (and, on Windows, its whole process tree via taskkill, so the Playwright-
 * launched browser doesn't get left running orphaned — see killProcessTree()'s comment). The
 * already-in-flight POST /cv-match request's own callback still fires once the process actually
 * exits and reports `errorMessage: 'Analysis stopped by user.'` — but the frontend has already
 * unsubscribed from that request by the time it calls this endpoint, so in practice that response
 * is only ever meaningful for this log line and isn't relied on to update the UI.
 */
router.post('/cv-match/stop', function(req, res) {
  if (!runningCvMatch) {
    console.error('[jobup-cv-match] stop requested but no analysis is currently running.');
    return res.json({ stopped: false });
  }

  console.error(
    '[jobup-cv-match] stop requested by user; killing the running analysis process (pid ' +
      runningCvMatch.process.pid + ').'
  );
  runningCvMatch.stoppedByUser = true;
  killProcessTree(runningCvMatch.process);
  runningCvMatch = null;
  res.json({ stopped: true });
});

/*
 * POST receives the CV match analysis data produced by scripts/jobup-cv-match.js and stores it —
 * `meter`/`criteria` are optional (only sent alongside a real analysis run) and, like `analysis`,
 * aren't persisted anywhere yet beyond this log line.
 */
router.post('/cv-analysis', function(req, res) {
  var analysis = req.body && req.body.analysis;

  if (typeof analysis !== 'string' || !analysis.trim()) {
    return res.status(400).json({ message: 'analysis text is required' });
  }

  console.log('[cv-analysis]', new Date().toISOString(), analysis);
  if (req.body && (req.body.meter || req.body.criteria)) {
    console.log('[cv-analysis] meter:', JSON.stringify(req.body.meter), 'criteria:', JSON.stringify(req.body.criteria));
  }

  res.json({ received: true });
});

module.exports = router;
