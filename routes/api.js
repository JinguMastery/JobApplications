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
 * { success, analysis, jobUrl, totalJobsCount } (the script also POSTs that same analysis text to
 * /cv-analysis itself before it exits). Takes a 1-based `jobIndex` in the body selecting which job
 * to analyze (defaults to 1); the script itself validates it against the actual result count.
 * Also takes a boolean `useBasicSearch` (defaults to false): when true, the script skips the
 * profile-based CTA and goes straight to the "Recherche d'emploi" sub-nav / basic-search entry
 * point; when false, it tries the CTA first and only falls back to basic search if unavailable.
 */
router.post('/cv-match', function(req, res) {
  var scriptPath = path.join(__dirname, '..', 'scripts', 'jobup-cv-match.js');
  var jobIndex = Number(req.body && req.body.jobIndex);
  if (!Number.isFinite(jobIndex)) {
    jobIndex = 1;
  }
  var useBasicSearch = !!(req.body && req.body.useBasicSearch);

  execFile('node', [scriptPath, String(jobIndex), String(useBasicSearch)], { timeout: 180000 }, function(err, stdout, stderr) {
    if (stderr) {
      console.error('[jobup-cv-match]', stderr.trim());
    }

    var success = false;
    var analysis = null;
    var jobUrl = null;
    var totalJobsCount = null;
    try {
      var parsed = JSON.parse(stdout.trim());
      success = !!parsed.success;
      analysis = parsed.analysis || null;
      jobUrl = parsed.jobUrl || null;
      totalJobsCount = typeof parsed.totalJobsCount === 'number' ? parsed.totalJobsCount : null;
    } catch (parseErr) {
      console.error('[jobup-cv-match] could not parse script output:', stdout);
    }

    res.json({
      success: success,
      analysis: analysis,
      jobUrl: jobUrl,
      totalJobsCount: totalJobsCount,
    });
  });
});

/* POST receives the CV match analysis text produced by scripts/jobup-cv-match.js and stores it. */
router.post('/cv-analysis', function(req, res) {
  var analysis = req.body && req.body.analysis;

  if (typeof analysis !== 'string' || !analysis.trim()) {
    return res.status(400).json({ message: 'analysis text is required' });
  }

  console.log('[cv-analysis]', new Date().toISOString(), analysis);

  res.json({ received: true });
});

module.exports = router;
