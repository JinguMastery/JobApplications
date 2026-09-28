require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var apiRouter = require('./routes/api');

var app = express();

// process.cwd() rather than __dirname: `npm run build` (see build.js) bundles this file's code
// together with routes/*.js into a single output file, so __dirname there would point wherever
// that bundled file happens to live, not this source file's own original directory — a mismatch
// that gets worse the deeper different merged files were originally nested (see routes/api.js's
// matching comment for the concrete failure mode). process.cwd() sidesteps that entirely: it
// works the same whether running the unbundled source (`npm start`, always run from the repo
// root — see CLAUDE.md) or the bundled dist/ output (expected to be started from its own root the
// same way), as long as views/ and public/ are copied alongside whichever entry file is actually
// run — which build.js does.
var APP_ROOT = process.cwd();

// view engine setup
app.set('views', path.join(APP_ROOT, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(APP_ROOT, 'public')));

// Allow the Angular dev server (ng serve, http://localhost:4200) to call the API directly
// when not going through the proxy configured in frontend/proxy.conf.json.
app.use('/api', cors({ origin: 'http://localhost:4200' }));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/api', apiRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
