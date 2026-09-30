#!/usr/bin/env node

/**
 * Standalone script (spawned as a child process by routes/api.js) that drives a real browser
 * to log into jobup.ch (or, with the "Use www.jobs.ch" checkbox on, jobs.ch — see loginToJobup()'s
 * own comment) and reports whether it succeeded.
 *
 * jobup.ch's "Se connecter" control is a JS-driven button (not a link) that opens an
 * Auth0-hosted universal-login flow with no stable URL, and its cookie-consent banner has two
 * different variants (a plain "ok" alert, and a fuller GDPR dialog) depending on the session.
 * See CLAUDE.md for how these selectors were derived.
 *
 * Reads credentials from JOBUP_EMAIL / JOBUP_PASSWORD (or JOBSCH_EMAIL / JOBSCH_PASSWORD, per the
 * "Use www.jobs.ch" checkbox — see the CLI block at the bottom of this file) and prints a single
 * JSON line to stdout: {"success": true|false, "errorMessage": string|null}. Diagnostic output goes
 * to stderr so stdout stays parseable. `errorMessage` is non-null for a specific, expected failure
 * that performLogin() detected immediately rather than surfacing as an opaque 30s timeout (a
 * LoginValidationError subclass — see its own comment): `'Invalid login credentials'` when
 * jobup.ch itself rejected the email/password, or `'Invalid email format'` when Auth0's own
 * client-side validator rejected the typed email before ever submitting it. `null` on every other
 * path, including success and genuinely unexpected errors.
 *
 * On a successful login (CLI invocation only — see the bottom of this file), rewrites the .env
 * file at the repo root with these same credentials, under the same site-matching variable names,
 * via updateEnvFile() below, so routes/api.js's POST /cv-match can pick them up for the very next
 * analysis without a server restart (see its own comment for how). A failed login leaves .env
 * completely untouched.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Dismisses whichever cookie-consent variant jobup.ch shows (it fades in over ~200ms, so
 * `.isVisible()` is unreliable here — it checks immediately rather than waiting for the
 * element to appear, which caused this to silently no-op before the dialog had mounted).
 */
async function dismissCookieConsent(page) {
  const cookieOkButton = page.getByRole('alert').getByRole('button', { name: 'ok', exact: true });
  const cookieAcceptAllButton = page
    .getByRole('dialog')
    .getByRole('button', { name: /accepter tous les cookies/i });

  const variant = await Promise.race([
    cookieOkButton.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'ok'),
    cookieAcceptAllButton.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'acceptAll'),
  ]).catch(() => null);

  if (variant === 'ok') {
    await cookieOkButton.click();
  } else if (variant === 'acceptAll') {
    await cookieAcceptAllButton.click();
  }
}

// Base class for a specific, known login-flow failure that performLogin() detected immediately —
// as opposed to returning false for a genuinely unexpected/ambiguous one, or letting Playwright
// time out waiting for a step that was never going to happen. Callers (this file's own CLI block
// below, scripts/jobup-cv-match.js) catch this base class rather than every individual subclass,
// so a new subclass added here is automatically reported the same explicit way — via its own
// `message` — without needing to touch either call site again.
class LoginValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

// jobup.ch's own "E-mail ou mot de passe incorrect" error (confirmed live at both the email and
// password steps — see the comments inside performLogin()).
class InvalidCredentialsError extends LoginValidationError {
  constructor() {
    super('Invalid login credentials');
  }
}

// Auth0's own client-side email-format validator rejected the typed email before the flow ever
// got as far as checking credentials — confirmed live via a user-supplied DOM snippet:
// `<div id="error-cs-email-invalid" class="ulp-error-info aria-error-check ulp-validator-error"
// data-ulp-validation-function="ulpEmailValidationFunction" ...>Saisissez une adresse e-mail
// valide (par exemple, user@domain.com).</div>`. This is stricter than this app's own frontend
// `type="email"` validation (see frontend/CLAUDE.md) — a value that passes the browser's native
// check can still be rejected here, so this remains reachable even with that validator in place.
class InvalidEmailFormatError extends LoginValidationError {
  constructor() {
    super('Invalid email format');
  }
}

/**
 * Drives the login flow on an already-open `page` (assumed to already be on jobup.ch with
 * cookie consent dismissed) and returns whether it succeeded. Split out from `loginToJobup` so
 * other scripts (e.g. scripts/jobup-cv-match.js) can log in and keep using the same page/browser
 * afterward instead of having it closed for them.
 */
async function performLogin(page, email, password) {
  await page.getByRole('button', { name: /se connecter/i }).first().click();
  await page.getByRole('textbox', { name: /adresse e-mail/i }).fill(email);
  await page.getByRole('button', { name: 'Continuer', exact: true }).click();

  // Confirmed live: jobup.ch's Auth0 flow can reject right after this EMAIL step — before the
  // password textbox ever renders — two different ways:
  // - `<span id="error-element-password" class="ulp-input-error-message"
  //   data-error-code="wrong-email-credentials">E-mail ou mot de passe incorrect</span>` — the
  //   exact same error element/text used for the later password-step failure below (the email
  //   itself is well-formed, but jobup.ch doesn't recognize it/the combination).
  // - `<div id="error-cs-email-invalid" ... data-ulp-validation-function="ulpEmailValidationFunction"
  //   ...>Saisissez une adresse e-mail valide (par exemple, user@domain.com).</div>` — Auth0's own
  //   client-side validator rejecting a malformed email before ever submitting it, stricter than
  //   this app's own frontend `type="email"` check (see frontend/CLAUDE.md).
  // An earlier version unconditionally `.fill()`-ed the password textbox next, which — for either
  // case — waited the full default 30s Playwright action-timeout for a field that was never going
  // to appear, surfacing as an opaque TimeoutError instead of the real, known cause. Racing the
  // password field's own appearance against both error texts here catches either immediately.
  const errorMessage = page.getByText(/e-mail ou mot de passe incorrect/i);
  const emailFormatError = page.getByText(/saisissez une adresse e-mail valide/i);
  const passwordField = page.getByRole('textbox', { name: /mot de passe/i });
  const afterEmailOutcome = await Promise.race([
    passwordField.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'passwordStep'),
    errorMessage.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'invalidCredentials'),
    emailFormatError.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'invalidEmailFormat'),
  ]).catch(() => 'timeout');

  if (afterEmailOutcome === 'invalidCredentials') {
    throw new InvalidCredentialsError();
  }
  if (afterEmailOutcome === 'invalidEmailFormat') {
    throw new InvalidEmailFormatError();
  }
  if (afterEmailOutcome === 'timeout') {
    return false;
  }

  await passwordField.fill(password);
  await page.getByRole('button', { name: 'Continuer', exact: true }).click();

  // Generalized to any `auth.*` host rather than hardcoding `auth.jobup.ch` specifically — this
  // same flow also drives jobs.ch (see the "Use www.jobs.ch" checkbox/routes/api.js's own comment)
  // via an Auth0-hosted universal-login flow at its own `auth.` subdomain, unverified live whether
  // that's the same `auth.jobup.ch` tenant or a separate `auth.jobs.ch` one — either way, success is
  // "navigated away from the auth subdomain back to the main site".
  const outcome = await Promise.race([
    page.waitForURL((url) => !url.hostname.startsWith('auth.'), { timeout: 20000 }).then(() => 'success'),
    errorMessage.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'invalidCredentials'),
  ]).catch(() => 'timeout');

  if (outcome === 'invalidCredentials') {
    throw new InvalidCredentialsError();
  }
  return outcome === 'success';
}

// useJobsCh drives www.jobs.ch instead of www.jobup.ch — see the "Use www.jobs.ch" checkbox next
// to the Login button (and, separately, the CV Analysis job filters' own copy of the same toggle,
// which threads through to scripts/jobup-search.js instead). jobs.ch's own Auth0-hosted login page
// is confirmed to live at auth.jobs.ch/u/login (user-supplied), a different host than jobup.ch's —
// performLogin()'s own success check was generalized from auth.jobup.ch specifically to any
// `auth.`-prefixed host for exactly this reason. Everything else here (cookie consent, the
// "Se connecter" flow itself) is otherwise assumed, not confirmed live, to carry over unchanged —
// see the root CLAUDE.md's "www.jobs.ch support" section.
async function loginToJobup(email, password, useJobsCh) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const baseUrl = useJobsCh ? 'https://www.jobs.ch' : 'https://www.jobup.ch';
    await page.goto(baseUrl + '/fr/');

    await dismissCookieConsent(page);

    return await performLogin(page, email, password);
  } finally {
    await browser.close();
  }
}

// Wraps a value in double quotes for a dotenv-compatible line — protects arbitrary email/password
// characters ('#', '=', leading/trailing spaces, etc.) that would otherwise be misread by dotenv's
// line-based parser if left unquoted (a bare '#' in particular would silently truncate the value as
// an inline comment). Confirmed against the installed dotenv version's own parser (both its default
// regex-based path and its opt-in "fast" path): a double-quoted value only ever gets '\n'/'\r'
// unescaped back to real newline/CR characters on read — a backslash-escaped quote or backslash is
// recognized only for *finding where the quoted value ends*, not unescaped afterward, so writing
// '\"' for an embedded '"' (as an earlier version of this function did) leaves a literal, wrong
// backslash in the value once read back rather than round-tripping it. There is no way to embed a
// literal '"' in a double-quoted value with this dotenv version that reads back byte-for-byte
// identical — so a real embedded newline/CR is escaped here (the one round-trip dotenv does
// support), but a '"' is left as-is and merely warned about.
function formatEnvValue(value) {
  var str = String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (str.indexOf('"') !== -1) {
    console.error(
      'warning: a value being written to .env contains a literal \'"\' character, ' +
        "which this dotenv version can't round-trip losslessly inside a quoted value — it will be " +
        'written as-is and may not read back identically.'
    );
  }
  return '"' + str + '"';
}

// Updates (or appends) KEY=value lines in the .env file at envPath for each key in `updates`,
// preserving every other line (comments, blank lines, unrelated vars) and their original order —
// only ever called after a confirmed-successful login (see the CLI block below), never
// speculatively, so a failed attempt is guaranteed to leave the file untouched.
function updateEnvFile(envPath, updates) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const remainingKeys = new Set(Object.keys(updates));

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([^#=\s][^=]*)=/);
    if (!match) {
      return line;
    }
    const key = match[1].trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      remainingKeys.delete(key);
      return key + '=' + formatEnvValue(updates[key]);
    }
    return line;
  });

  for (const key of remainingKeys) {
    updatedLines.push(key + '=' + formatEnvValue(updates[key]));
  }

  // A file ending in a newline splits into a trailing '' element — drop it before rejoining so we
  // don't accumulate a growing run of blank lines across repeated updates.
  while (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === '') {
    updatedLines.pop();
  }

  fs.writeFileSync(envPath, updatedLines.join('\n') + '\n', 'utf8');
}

module.exports = {
  dismissCookieConsent,
  performLogin,
  loginToJobup,
  LoginValidationError,
  InvalidCredentialsError,
  InvalidEmailFormatError
};

// Only run as a standalone CLI when invoked directly (`node scripts/jobup-login.js`), not when
// required by another script (scripts/jobup-search.js reuses `dismissCookieConsent`/`performLogin`
// on its own page/browser instead of `loginToJobup`, which launches its own).
// process.argv[2] (`'true'`/`'1'`) selects which credential pair to read/write — JOBSCH_EMAIL/
// JOBSCH_PASSWORD for jobs.ch, JOBUP_EMAIL/JOBUP_PASSWORD (the original, default pair) for jobup.ch
// — routes/api.js's POST /login passes this through from the frontend's "Use www.jobs.ch" checkbox,
// alongside overriding the *matching* env var names with whatever was just typed in the form (see
// its own comment).
if (require.main === module) {
  (async () => {
    const useJobsCh = process.argv[2] === 'true' || process.argv[2] === '1';
    const emailVar = useJobsCh ? 'JOBSCH_EMAIL' : 'JOBUP_EMAIL';
    const passwordVar = useJobsCh ? 'JOBSCH_PASSWORD' : 'JOBUP_PASSWORD';
    const email = process.env[emailVar];
    const password = process.env[passwordVar];

    if (!email || !password) {
      console.error(emailVar + ' and ' + passwordVar + ' environment variables are required.');
      process.stdout.write(JSON.stringify({ success: false, errorMessage: null }));
      return;
    }

    try {
      const success = await loginToJobup(email, password, useJobsCh);
      if (success) {
        try {
          // process.cwd() rather than __dirname — see routes/api.js's matching comment on
          // APP_ROOT: `npm run build` bundles this file to its own standalone output file, whose
          // __dirname at runtime is wherever that file physically lands, not necessarily still one
          // level under the repo root the way this source file (in scripts/) is. process.cwd()
          // works the same regardless, for both the unbundled source and the bundled dist/ output.
          updateEnvFile(path.join(process.cwd(), '.env'), { [emailVar]: email, [passwordVar]: password });
          console.error('login succeeded; updated .env with the new credentials.');
        } catch (envErr) {
          // The login itself still succeeded — don't turn a working login into a reported failure
          // just because persisting it for next time didn't work.
          console.error('login succeeded but failed to update .env:', envErr.message);
        }
      }
      process.stdout.write(JSON.stringify({ success, errorMessage: null }));
    } catch (err) {
      if (err instanceof LoginValidationError) {
        // A specific, expected failure (wrong credentials, or — per LoginValidationError's own
        // comment — a jobup.ch-side validator rejecting the email format) — reported explicitly
        // and immediately, rather than surfacing as an opaque 30s timeout on a field/step that was
        // never going to happen (see performLogin()'s comment for how each is detected).
        console.error(err.message + '.');
        process.stdout.write(JSON.stringify({ success: false, errorMessage: err.message }));
        return;
      }
      // Deliberately not a raw `console.error(err)` — that dumps Playwright's multi-line
      // TimeoutError object (call log, stack trace, everything) into the backend console as an
      // opaque blob. This one-line, explicit message (name + message only, no '[jobup-login]'
      // prefix — routes/api.js already prepends that once when it forwards this script's stderr
      // to the backend console, so adding it here too would just double it up) is what actually
      // shows up there — e.g. "login automation failed
      // unexpectedly: TimeoutError: locator.fill: Timeout 30000ms exceeded." when a step's expected
      // element (the password textbox, an Auth0 button, etc.) never appeared for some other,
      // unrecognized reason, which usually means either the login flow changed/broke at an earlier
      // step or jobup.ch's markup itself changed.
      console.error(
        'login automation failed unexpectedly: ' + err.name + ': ' + err.message
      );
      process.stdout.write(JSON.stringify({ success: false, errorMessage: null }));
    }
  })();
}
