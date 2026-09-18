#!/usr/bin/env node

/**
 * Standalone script (spawned as a child process by routes/api.js) that drives a real browser
 * to log into jobup.ch and reports whether it succeeded.
 *
 * jobup.ch's "Se connecter" control is a JS-driven button (not a link) that opens an
 * Auth0-hosted universal-login flow with no stable URL, and its cookie-consent banner has two
 * different variants (a plain "ok" alert, and a fuller GDPR dialog) depending on the session.
 * See CLAUDE.md for how these selectors were derived.
 *
 * Reads credentials from JOBUP_EMAIL / JOBUP_PASSWORD and prints a single JSON line to stdout:
 * {"success": true|false}. Diagnostic output goes to stderr so stdout stays parseable.
 */

const { chromium } = require('playwright');

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

async function loginToJobup(email, password) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('https://www.jobup.ch/fr/');

    await dismissCookieConsent(page);

    await page.getByRole('button', { name: /se connecter/i }).first().click();
    await page.getByRole('textbox', { name: /adresse e-mail/i }).fill(email);
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();

    await page.getByRole('textbox', { name: /mot de passe/i }).fill(password);
    await page.getByRole('button', { name: 'Continuer', exact: true }).click();

    const errorMessage = page.getByText(/e-mail ou mot de passe incorrect/i);
    const outcome = await Promise.race([
      page.waitForURL((url) => !url.hostname.includes('auth.jobup.ch'), { timeout: 20000 }).then(() => 'success'),
      errorMessage.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'failure'),
    ]).catch(() => 'timeout');

    return outcome === 'success';
  } finally {
    await browser.close();
  }
}

(async () => {
  const email = process.env.JOBUP_EMAIL;
  const password = process.env.JOBUP_PASSWORD;

  if (!email || !password) {
    console.error('JOBUP_EMAIL and JOBUP_PASSWORD environment variables are required.');
    process.stdout.write(JSON.stringify({ success: false }));
    return;
  }

  try {
    const success = await loginToJobup(email, password);
    process.stdout.write(JSON.stringify({ success }));
  } catch (err) {
    console.error(err);
    process.stdout.write(JSON.stringify({ success: false }));
  }
})();
