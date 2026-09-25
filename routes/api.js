var express = require('express');
var path = require('path');
var execFile = require('child_process').execFile;
var router = express.Router();

/* GET backend health status, used by the Angular frontend to verify connectivity. */
router.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'express-backend', timestamp: new Date().toISOString() });
});

/*
 * POST triggers the jobup.ch login automation as a background process (see
 * scripts/jobup-login.js), waits for it to finish, and reports the outcome as a display string.
 */
router.post('/login', function(req, res) {
  var scriptPath = path.join(__dirname, '..', 'scripts', 'jobup-login.js');

  execFile('node', [scriptPath], { timeout: 60000 }, function(err, stdout, stderr) {
    if (stderr) {
      console.error('[jobup-login]', stderr.trim());
    }

    var success = false;
    try {
      success = !!JSON.parse(stdout.trim()).success;
    } catch (parseErr) {
      console.error('[jobup-login] could not parse script output:', stdout);
    }

    res.json({ success: success, message: success ? 'Login succeeded !' : 'Login failed !' });
  });
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
 * only when the run failed before any search ran (e.g. login failure).
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
 */
router.post('/cv-match', function(req, res) {
  var scriptPath = path.join(__dirname, '..', 'scripts', 'jobup-cv-match.js');
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

  execFile(
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
    { timeout: 180000 },
    function(err, stdout, stderr) {
      if (stderr) {
        console.error('[jobup-cv-match]', stderr.trim());
      }

      var success = false;
      var analysis = null;
      var meter = null;
      var criteria = [];
      var jobUrl = null;
      var totalJobsCount = null;
      var errorMessage = null;
      var resultsUrl = null;
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
      } catch (parseErr) {
        console.error('[jobup-cv-match] could not parse script output:', stdout);
      }

      res.json({
        success: success,
        analysis: analysis,
        meter: meter,
        criteria: criteria,
        jobUrl: jobUrl,
        totalJobsCount: totalJobsCount,
        errorMessage: errorMessage,
        resultsUrl: resultsUrl,
      });
    }
  );
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
