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

    res.json({ message: success ? 'Login succeeded !' : 'Login failed !' });
  });
});

module.exports = router;
