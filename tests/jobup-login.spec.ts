import { test, expect } from '@playwright/test';

/**
 * jobup.ch renders its "Se connecter" (sign in) control as a button with no static href
 * (it opens an Auth0-hosted login flow), so this navigates via the UI rather than guessing
 * a login URL directly. The login page asks for an email first; the password field only
 * appears on the next step, so we assert on the login heading and email field instead.
 *
 * The cookie-consent banner has two variants that appear inconsistently between sessions:
 * a plain alert with an "ok" button, and a fuller GDPR dialog with "Accepter tous les cookies".
 * It fades in over ~200ms, so `.isVisible()` (which checks immediately rather than waiting)
 * is unreliable here — use `.waitFor({ state: 'visible' })` instead, which properly waits.
 */
test('navigates to the jobup.ch login page', async ({ page }) => {
  await page.goto('https://www.jobup.ch/fr/');

  const cookieOkButton = page.getByRole('alert').getByRole('button', { name: 'ok', exact: true });
  const cookieAcceptAllButton = page.getByRole('dialog').getByRole('button', { name: /accepter tous les cookies/i });
  const variant = await Promise.race([
    cookieOkButton.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'ok'),
    cookieAcceptAllButton.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'acceptAll'),
  ]).catch(() => null);
  if (variant === 'ok') {
    await cookieOkButton.click();
  } else if (variant === 'acceptAll') {
    await cookieAcceptAllButton.click();
  }

  await page.getByRole('button', { name: /se connecter|log in|sign in/i }).first().click();

  await expect(page.getByRole('heading', { name: /se connecter|log in|sign in/i })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /adresse e-mail|email/i })).toBeVisible();
});
