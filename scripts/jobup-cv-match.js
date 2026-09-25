#!/usr/bin/env node

/**
 * Standalone script (spawned as a child process by routes/api.js) that logs into jobup.ch,
 * runs a profile-based job search, opens the i-th result (1-based, across all result pages), runs
 * (or reads, if already run before) jobup's AI CV-match analysis for that job, and reports the
 * analysis text.
 *
 * Reuses the login flow from scripts/jobup-login.js (see that file and CLAUDE.md for how the
 * Auth0 login selectors were derived, and for the two cookie-consent variants). The post-login
 * selectors have been iteratively verified against the live site (see CLAUDE.md's "jobup.ch
 * CV-match automation" section for the gotchas hit along the way — several elements aren't what
 * their visible label would suggest). If jobup.ch changes and a selector stops matching, re-derive
 * it the same way: run this script directly (`JOBUP_EMAIL=... JOBUP_PASSWORD=... node
 * scripts/jobup-cv-match.js [jobIndex] [useBasicSearch] [searchTerm] [locationsJson] [saveJob]
 * [easyApply] [ignoreYellowMeter]`) and inspect `page.locator('body').ariaSnapshot()`.
 *
 * Reads credentials from JOBUP_EMAIL / JOBUP_PASSWORD, the 1-based job index to select from
 * `process.argv[2]` (defaults to 1, the first job), and whether to skip straight to the
 * "Recherche d'emploi" sub-nav tab / basic-search entry point instead of the profile-based CTA
 * from `process.argv[3]` (`'true'`/`'1'`; defaults to false, i.e. try the CTA first as usual and
 * only fall back to basic search if it's unavailable). `process.argv[4]` is a custom search term
 * (falls back to RECOVERY_SEARCH_TERM when empty — and is ignored entirely whenever "Rechercher
 * avec mon profil" ends up being used, since that CTA generates its own profile-derived term
 * server-side); `process.argv[5]` is a JSON-encoded array of custom locations (falls back to
 * `[LOCATION_SLUG]` when empty/absent), each appended as its own `location=` query param wherever
 * this file applies a location filter. jobup.ch paginates results at JOBS_PER_PAGE (20) per page,
 * so an index beyond the first page clicks a "next page" control that many times
 * (deep-linking via a `?page=N` query param doesn't work — see CLAUDE.md) and selects position
 * `((jobIndex - 1) % 20) + 1` on the page it lands on. If the index is not a positive integer
 * (errorMessage: "Job index must be a positive integer") or exceeds the number of jobs actually
 * found on its target page (errorMessage: "Job index must not be greater than the number of jobs
 * found on that page"), returns success: false without attempting an analysis — but only *after*
 * the search itself has run and `totalJobsCount` is known, so both cases still report it rather
 * than `null` (an invalid index doesn't mean the search itself found nothing useful to report).
 * Once the analysis text is available, POSTs it as { analysis, meter, criteria } to
 * `${BACKEND_URL}/api/cv-analysis` (BACKEND_URL defaults to http://localhost:3000) before
 * dismissing the result dialog. `meter` ({ color: 'green'|'yellow'| null, percent: number|null })
 * and `criteria` ([{ text: string, status: 'green'|'yellow'|'gray' }]) are read straight from the
 * DOM (icon/fill color, not text) via extractAnalysisStructure() — see its comment for how, since
 * none of that survives a plain innerText() read. Prints a single JSON line to stdout:
 * {"success": true|false, "analysis": string|null, "meter": object|null, "criteria": array,
 * "jobUrl": string|null, "totalJobsCount": number|null, "errorMessage": string|null}. `jobUrl` is
 * the selected job's own detail-page URL
 * (https://www.jobup.ch/fr/emplois/detail/...), read from the job link's `href` before clicking
 * it — jobup.ch renders the job detail in place rather than navigating there, so the browser's own
 * URL after the click is still the search results page, not the job. `totalJobsCount` is the
 * total-match count read from the "... offres d'emploi" text near the top of the results page —
 * except when that text's own number comes out to JOBS_PER_PAGE (20) or less, in which case every
 * matching job fits on this one page already, so the actual rendered job cards are counted
 * directly and trusted over that text instead (confirmed live: the text can be wrong on a small
 * result set — seen reporting 1 while 3 distinct cards were actually rendered).
 * `errorMessage` is non-null only for specific, expected failures meant to be shown to the user
 * as-is (see the jobIndex cases above, and EmptyResultsError below for the 0-results case); it's
 * null on every other path, including genuinely unexpected errors.
 *
 * If the analysis's meter is present at all (green *or* yellow — only its absence, the "Vos
 * talents correspondent mieux à d'autres opportunités" heading, skips this outright),
 * prepareJobApplicationDraft() saves the job ("Sauvegarder") when `saveJob` is true and, when
 * `easyApply` is true and "Candidature simplifiée"/"Continuer ma candidature" is available on the
 * job page, opens it — in a new tab, handled via the same BrowserContext.waitForEvent('page'), no
 * separate script/browser needed — and prepares (never submits) a draft application there:
 * generates a cover letter via "Générer" if the field is required and empty, attaches
 * REQUIRED_DOCUMENT_NAMES from the profile if not already present, answers every yes/no question
 * "Oui", then clicks "Sauvegarder" on the application itself. `ignoreYellowMeter`, when true,
 * additionally skips both actions entirely for a yellow meter (only green then qualifies); when
 * false (the default), both green and yellow are treated the same. `saveJob`/`easyApply` gate
 * their two actions independently — either, both, or neither can be enabled. None of this — nor
 * the meter/criteria extraction it depends on — has been verified against the live site (no
 * jobup.ch session was available in this environment); a failure here is logged and swallowed
 * rather than failing the run, since the analysis itself already succeeded by that point.
 * Diagnostic output goes to stderr so stdout stays parseable.
 */

const { chromium } = require('playwright');
const { dismissCookieConsent, performLogin } = require('./jobup-login');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const JOBS_PER_PAGE = 20;

// The "Aller à la recherche basique" recovery UI's search ends up with an empty `term` query
// param — confirmed live: it returned ~36000 jobs (location-filtered only) vs. ~2500-3000 on the
// direct CTA path, because that path's "Rechercher avec mon profil" auto-generates a
// profile-derived search term server-side that this recovery UI never receives. Filling in this
// fixed keyword compensates for that (a real profile-derived term isn't available to this script).
const RECOVERY_SEARCH_TERM = 'Développeur';

// The location applied via the `location=<slug>` query param (see the comment where it's used,
// below) — confirmed live as a real, working slug: `location=genève` returns genuinely
// Genève-filtered results (e.g. "10 Offres d'emploi Développeur à Genève").
const LOCATION_SLUG = 'Genève';

// The three profile documents attached to a draft application whenever prepareJobApplicationDraft()
// runs (see its comment) — skipped individually if already present as a link on the application
// page. Exact filenames as they appear in the jobup.ch profile's document picker.
const REQUIRED_DOCUMENT_NAMES = [
  'Certificat de travail L HERAULT 2026.04.pdf',
  'Diplôme Bachelor 2020.pdf',
  'LR-ITADV.pdf'
];

// Appends one `location=` query param per entry, as requested (multiple repeated `location=`
// params rather than one comma-joined value). Only a single `location=<slug>` value was ever
// confirmed live (see the location-filtering gotcha above/in CLAUDE.md) — this hasn't been
// re-verified with more than one location at once, so if jobup.ch turns out not to support
// multiple `location` params the same way, re-derive it live the usual way.
function appendLocations(url, locations) {
  for (const location of locations) {
    url.searchParams.append('location', location);
  }
}

async function sendAnalysisToBackend(analysis, meter, criteria) {
  const response = await fetch(BACKEND_URL + '/api/cv-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis, meter, criteria }),
  });

  if (!response.ok) {
    throw new Error('Backend responded with ' + response.status + ' while posting CV analysis');
  }
}

// Reads the analysis modal's per-criterion status icons and overall match meter, none of which
// survive a plain .innerText() read (they're conveyed only by icon/fill color, not text). Derived
// from a user-supplied live DOM dump of the modal rather than a run of this script itself (no
// jobup.ch session was available to verify it end-to-end the usual way — see the file header) —
// if these ever stop matching, re-derive them the documented way: dump `.icon--iconSize_sm` class
// values and "bg_yellow"/"bg_green" candidate classes via the criteria.length === 0 / meter === null
// diagnostics in readAnalysisAndClose() below, or a fresh live DOM dump.
//
// Status icons: each criterion row has one `<span class="c_green.400 ... icon icon--iconSize_sm">`
// (met), `c_yellow.300` (partially met) or `c_gray.700` (not met) wrapping a decorative
// (aria-hidden, textless) SVG — so the icon's own parent element's innerText is exactly that row's
// title (plus its explanation line, if jobup's AI gave one), with no icon noise mixed in.
//
// Meter: one colored fill div (originally seen nested in a "bg_gray.200" gray track div) whose own
// class gives both the overall-match color ("bg_green..." / "bg_yellow...") and its width as a
// Panda-CSS fraction token (e.g. "w_1/3") or arbitrary-value token (e.g. "w_[45%]") — found by
// searching the fill's own class directly (see the comment on the search below for why, having
// first shipped a version that went via the track and silently failed live).
async function extractAnalysisStructure(analysisDialog) {
  return analysisDialog.evaluate((root) => {
    function classifyStatus(cls) {
      if (!cls) return null;
      if (cls.includes('c_green')) return 'green';
      if (cls.includes('c_yellow')) return 'yellow';
      if (cls.includes('c_gray')) return 'gray';
      return null;
    }

    function parseWidthPercent(cls) {
      const fraction = cls.match(/w_(\d+)\/(\d+)/);
      if (fraction) {
        return Math.round((Number(fraction[1]) / Number(fraction[2])) * 100);
      }
      const arbitrary = cls.match(/w_\[(\d+(?:\.\d+)?)%?\]/);
      if (arbitrary) {
        return Math.round(Number(arbitrary[1]));
      }
      return null;
    }

    // Searches directly for the *fill* div (its own class carries both the color and the width),
    // rather than first locating a "bg_gray.200" track ancestor — the modal can contain other
    // bg_gray.200-classed elements for unrelated purposes, and querySelector() would silently
    // grab the wrong one (yielding a false-negative null meter) if one of those happens to sit
    // earlier in the DOM. A "bg_green.../bg_yellow..." element that also carries a parseable width
    // token is specific enough to the meter fill to not need the track as a scoping step at all.
    let meter = null;
    for (const candidate of root.querySelectorAll('[class*="bg_yellow"], [class*="bg_green"]')) {
      const cls = candidate.getAttribute('class') || '';
      const percent = parseWidthPercent(cls);
      if (percent === null) continue;
      const color = cls.includes('bg_green') ? 'green' : cls.includes('bg_yellow') ? 'yellow' : null;
      meter = { color, percent };
      break;
    }

    const criteria = [];
    for (const icon of root.querySelectorAll('.icon--iconSize_sm')) {
      const status = classifyStatus(icon.getAttribute('class') || '');
      if (!status) continue;
      let row = icon.parentElement;
      let text = row ? row.innerText.trim() : '';
      let hops = 0;
      while (row && !text && hops < 3) {
        row = row.parentElement;
        text = row ? row.innerText.trim() : '';
        hops++;
      }
      if (text) {
        criteria.push({ text, status });
      }
    }

    return { meter, criteria };
  });
}

// Removes items whose `href` repeats an earlier one, keeping the first (topmost) occurrence —
// confirmed live: the same job can appear twice in the matched set, at a very different `x`
// (e.g. 71 vs 454), suggesting a second rendering elsewhere on the page (a "recommended"/
// promotional widget also using `data-cy="job-link"`) rather than the main results list itself
// duplicating entries. Items with no `href` (possible on the `role="article"` fallback pattern,
// where the link is nested rather than on the element itself) are never treated as duplicates of
// each other, since there's nothing to compare.
function dedupeByHref(items) {
  const seen = new Set();
  const deduped = [];
  const duplicateHrefs = [];
  for (const item of items) {
    if (item.href && seen.has(item.href)) {
      duplicateHrefs.push(item.href);
      continue;
    }
    if (item.href) {
      seen.add(item.href);
    }
    deduped.push(item);
  }
  return { deduped, duplicateHrefs };
}

// Thrown by waitForJobResults() when jobup.ch itself reports 0 matches for the current
// term/location combination — distinct from every other failure in this file (a real selector
// break, a network hiccup, etc.), which stay as plain Errors/TimeoutErrors. runCvMatch()'s single
// catch for this type is what turns it into an explicit, immediate success:false response instead
// of running the 20s locator wait all the way out to a generic Playwright TimeoutError.
class EmptyResultsError extends Error {
  constructor(pageLabel) {
    super('jobup.ch reported 0 matching jobs on page ' + pageLabel);
    this.name = 'EmptyResultsError';
  }
}

// Waits for at least one job result to render on the current page. Confirmed live: a search with
// 0 matches (e.g. term/location combination too narrow) renders a `[data-cy="empty-result"]`
// element instead of any job-link/article element — without racing against it too, the previous
// version of this function just sat out the full 20s locator timeout and surfaced a generic,
// unhelpful Playwright TimeoutError for what is actually a normal, expected outcome. Dumps
// diagnostics and rethrows only if genuinely neither state appears (a real break, not 0 results).
// Shared between the initial page-1 wait and, if jobIndex requires pagination, the wait after
// navigating to the target page.
async function waitForJobResults(page, anyJobResult, pageLabel) {
  const emptyResult = page.locator('[data-cy="empty-result"]');
  const outcome = await Promise.race([
    anyJobResult.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'results'),
    emptyResult.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'empty')
  ]).catch(() => null);

  if (outcome === 'results') {
    return;
  }
  if (outcome === 'empty') {
    throw new EmptyResultsError(pageLabel);
  }

  const jobHrefs = await page.locator('a[href*="/emploi/"]').evaluateAll((els) =>
    els.slice(0, 5).map((el) => ({ href: el.getAttribute('href'), text: el.textContent?.trim().slice(0, 80) }))
  );
  const dataCyCandidates = await page.locator('[data-cy]').evaluateAll((els) => {
    const seen = new Set();
    for (const el of els) {
      const v = el.getAttribute('data-cy');
      if (v && /job|offer|listing|result|card/i.test(v)) seen.add(v);
    }
    return [...seen];
  });
  console.error(
    '[jobup-cv-match] could not find a job result on page ' + pageLabel + '. Current URL:',
    page.url(),
    'Candidate job links:',
    JSON.stringify(jobHrefs),
    'Candidate data-cy values:',
    JSON.stringify(dataCyCandidates)
  );
  throw new Error('Timed out waiting for job results on page ' + pageLabel);
}

// Reads the analysis dialog's text, posts it to the backend, and dismisses it via "Fermer".
// Shared by both the "already analyzed" and "run a new analysis" paths below. Confirmed live: a
// plain `getByRole('dialog')` is ambiguous (Playwright strict-mode violation) — the "estimation in
// progress" placeholder (`data-cy="jobfit-pending-modal"`) and the actual result
// (`data-cy="jobfit-analysis-modal"`) both stay mounted as `<dialog>` elements at once, so this
// targets the result modal by its `data-cy` specifically.
async function readAnalysisAndClose(page, waitTimeout) {
  const analysisDialog = page.locator('[data-cy="jobfit-analysis-modal"]');
  const closeButton = analysisDialog.getByRole('button', { name: /fermer/i });
  await closeButton.waitFor({ state: 'visible', timeout: waitTimeout });

  const analysis = (await analysisDialog.innerText()).trim();
  const { meter, criteria } = await extractAnalysisStructure(analysisDialog);

  if (criteria.length === 0) {
    const iconClasses = await analysisDialog
      .locator('.icon--iconSize_sm')
      .evaluateAll((els) => els.slice(0, 10).map((el) => el.getAttribute('class')));
    console.error(
      '[jobup-cv-match] extractAnalysisStructure() found 0 criteria; status-icon classes seen:',
      JSON.stringify(iconClasses)
    );
  }
  if (!meter) {
    const meterCandidateClasses = await analysisDialog
      .locator('[class*="bg_yellow"], [class*="bg_green"], [class*="bg_gray.200"]')
      .evaluateAll((els) => els.slice(0, 10).map((el) => el.getAttribute('class')));
    console.error(
      '[jobup-cv-match] extractAnalysisStructure() found no meter; candidate classes seen:',
      JSON.stringify(meterCandidateClasses)
    );
  }

  await sendAnalysisToBackend(analysis, meter, criteria);

  await closeButton.click();

  return { analysis, meter, criteria };
}

// If the cover-letter field is present, required (an errorMain-colored "*" span somewhere near its
// label), and still empty, clicks "Générer" to have jobup.ch generate one. Left untouched if it's
// not required or already has content. None of this has been verified live (see the header comment
// and prepareJobApplicationDraft()'s comment) — the required-marker class
// (`c_colorPalette.errorMain`) and label text come from a user-supplied live DOM snippet, but the
// walk from label to marker/textarea is a best-effort guess at the surrounding structure. Every
// `.first()` below is scoped `.and(applicationPage.locator(':visible'))` — confirmed live elsewhere
// on this page (the job-page "Sauvegarder" button) that jobup.ch duplicates markup (even a whole
// duplicated `id`) for responsive mobile/desktop layouts and hides one copy via an ancestor, which
// `.first()` alone can't tell apart from the real, on-screen one.
async function generateCoverLetterIfNeeded(applicationPage) {
  const visible = applicationPage.locator(':visible');
  const label = applicationPage
    .getByText('Écrivez votre lettre de motivation ici', { exact: false })
    .and(visible)
    .first();
  const labelVisible = await label.isVisible({ timeout: 10000 }).catch(() => false);
  if (!labelVisible) {
    console.error('[jobup-cv-match] cover-letter label not found on the application page; skipping.');
    return;
  }

  // Walk up from the label a few levels looking for both the required-marker span and the actual
  // text field, since the exact DOM depth between them isn't known — stop as soon as either is
  // found, or after a handful of hops. Confirmed live this over-matched at 6 hops: a cover letter
  // that visibly has no asterisk still got treated as required, because by the 5th/6th hop the
  // container had grown large enough to also contain some *other*, unrelated field's own required
  // marker elsewhere on the form. Cut down to 2 hops — a real miss (field genuinely required but
  // the marker sits further away structurally) is the safer failure mode here than generating an
  // unwanted cover letter, and the diagnostic dump below shows exactly what was found if this
  // still needs recalibrating.
  let container = label;
  let isRequired = false;
  let hasExistingText = false;
  let matchedMarkerHtml = null;
  let fieldLocator = null;
  for (let hops = 0; hops < 2; hops++) {
    container = container.locator('xpath=..');
    const markers = container.locator('[class~="c_colorPalette.errorMain"]').and(visible);
    isRequired = (await markers.count()) > 0;
    if (isRequired && !matchedMarkerHtml) {
      matchedMarkerHtml = await markers.first().evaluate((el) => el.outerHTML).catch(() => null);
    }
    const field = container.locator('textarea, [contenteditable="true"]').and(visible).first();
    if (await field.isVisible().catch(() => false)) {
      fieldLocator = field;
      const value =
        (await field.inputValue().catch(() => null)) ?? (await field.textContent().catch(() => ''));
      hasExistingText = !!(value && value.trim());
    }
    if (isRequired || hasExistingText) {
      break;
    }
  }

  if (!isRequired) {
    // Not required — but if it already has content (e.g. left over from an earlier, possibly
    // over-eager run — see the false-positive-required gotcha this same function used to have),
    // clear it too, so an optional cover letter is only ever present when actually meant to be.
    if (hasExistingText && fieldLocator) {
      await clearCoverLetterField(fieldLocator);
    } else {
      console.error('[jobup-cv-match] cover-letter field is not marked required; leaving it as-is.');
    }
    return;
  }
  console.error(
    '[jobup-cv-match] cover-letter field detected as required; marker found:',
    matchedMarkerHtml
  );
  if (hasExistingText) {
    console.error('[jobup-cv-match] cover letter already has content; not regenerating.');
    return;
  }

  const generateButton = applicationPage.getByRole('button', { name: /générer/i }).and(visible);
  if (await generateButton.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await generateButton.first().click();
    console.error('[jobup-cv-match] clicked "Générer" for the cover letter.');
    // Generation likely takes a moment; give it a window but don't fail the whole draft if it
    // doesn't finish — the rest of the draft (documents, questions) can still be prepared.
    await applicationPage.waitForTimeout(5000);
  } else {
    console.error('[jobup-cv-match] cover-letter field is required but no "Générer" button was found.');
  }
}

// Empties a cover-letter field found to hold leftover content when the field turned out to be
// optional. `<textarea>` supports .fill(''); a contenteditable div does not, so it's cleared via
// direct DOM manipulation plus a dispatched 'input' event (the framework listens for that event,
// not a value/property mutation, to notice the change — the same reasoning as elsewhere in this
// script where a UI event, not a raw property write, is what the page actually reacts to).
async function clearCoverLetterField(fieldLocator) {
  const tagName = await fieldLocator.evaluate((el) => el.tagName).catch(() => null);
  try {
    if (tagName === 'TEXTAREA') {
      await fieldLocator.fill('');
    } else {
      await fieldLocator.evaluate((el) => {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    console.error('[jobup-cv-match] cover-letter field was optional but had leftover content; cleared it.');
  } catch (err) {
    console.error('[jobup-cv-match] failed to clear leftover cover-letter content:', err.message);
  }
}

// Confirmed live (two real matches, one genuine and one false positive): a genuinely attached
// document's filename renders as a real `<a href="https://media.jobs.ch/...">` download link, while
// a still-open "Sélectionner depuis le profil" picker's file options render as plain, href-less
// `<span class="c_link...">` elements sharing the same link-styled classes — text-alone matching
// can't tell them apart, but the presence of a real `href` on an `<a>` ancestor can. Walks up to 4
// hops from the matched text looking for that anchor.
async function isRealAttachedDocumentLink(locator) {
  return locator
    .first()
    .evaluate((el) => {
      let node = el;
      for (let hop = 0; hop < 4 && node; hop++) {
        if (node.tagName === 'A' && node.getAttribute('href')) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    })
    .catch(() => false);
}

// Attaches each of REQUIRED_DOCUMENT_NAMES via "Ajouter d'autres documents" → "Sélectionner depuis
// le profil" → the matching filename → "Ajouter", skipping any filename already present as a link
// on the page. Repeats the whole click sequence per file, per the user's spec. Unverified live —
// the "Sélectionner depuis le profil" text/class comes from a user-supplied snippet, everything
// else (button labels) is a best guess pending a real run's diagnostics.
async function attachMissingDocuments(applicationPage) {
  const visible = applicationPage.locator(':visible');
  for (const fileName of REQUIRED_DOCUMENT_NAMES) {
    const textMatchLocator = applicationPage.getByText(fileName, { exact: true }).and(visible);
    const textMatched = await textMatchLocator.first().isVisible().catch(() => false);
    const alreadyAttached = textMatched && (await isRealAttachedDocumentLink(textMatchLocator));
    if (alreadyAttached) {
      const matchedHtml = await textMatchLocator
        .first()
        .evaluate((el) => (el.closest('[class]') || el).outerHTML.slice(0, 300))
        .catch(() => null);
      console.error(
        '[jobup-cv-match] "' + fileName + '" matched as already attached (real document link); skipping. ' +
          'Matched element context:',
        matchedHtml
      );
      continue;
    }
    if (textMatched) {
      // Confirmed live: text matched somewhere on the page (e.g. a leftover, still-open
      // "Sélectionner depuis le profil" picker option) but it isn't a real attached-document link —
      // don't skip; proceed to attach it for real. Dumped for visibility since this previously
      // caused a silent false "already attached" skip.
      const matchedTag = await textMatchLocator.first().evaluate((el) => el.tagName).catch(() => null);
      console.error(
        '[jobup-cv-match] "' + fileName + '" text matched (tag: ' + matchedTag + ') but is not a real ' +
          'attached-document link; proceeding to attach it.'
      );
    }

    const addDocsButton = applicationPage.getByRole('button', { name: /ajouter d.autres documents/i }).and(visible);
    if (!(await addDocsButton.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error(
        '[jobup-cv-match] "Ajouter d\'autres documents" button not found; cannot attach "' + fileName + '".'
      );
      continue;
    }
    await addDocsButton.first().click();

    const selectFromProfile = applicationPage.getByText('Sélectionner depuis le profil', { exact: true }).and(visible);
    if (!(await selectFromProfile.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error('[jobup-cv-match] "Sélectionner depuis le profil" not found for "' + fileName + '".');
      continue;
    }
    await selectFromProfile.first().click();

    const fileOption = applicationPage.getByText(fileName, { exact: true }).and(visible);
    if (!(await fileOption.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error('[jobup-cv-match] file option "' + fileName + '" not found in the profile picker.');
      continue;
    }
    await fileOption.first().click();

    // Left anchored (unlike the job-page "Sauvegarder" fix above) rather than relaxed to
    // /ajouter/i: "Ajouter d'autres documents" (a different, already-clicked button) is plausibly
    // still visible in the same panel at this point, and an unanchored match risks .first()
    // grabbing *that* one instead of this confirm button — a worse bug than the one it'd fix. If
    // this exact-match ever turns out to miss the same way "Sauvegarder" did (an aria-label
    // overriding "Ajouter"), the diagnostics below say exactly what's there instead of guessing.
    const confirmAddButton = applicationPage.getByRole('button', { name: /^ajouter$/i }).and(visible);
    if (await confirmAddButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
      await confirmAddButton.first().click();
      console.error('[jobup-cv-match] attached "' + fileName + '".');
      // Confirmed live (root cause of the false "already attached" positives above, now resolved
      // with the href-based check): the picker's actual file-list panel can stay open after
      // "Ajouter" even once `selectFromProfile` (the *menu-item label* that opened it, not the
      // panel itself) reports hidden — waiting on that label alone isn't a reliable close signal, it
      // was just closing itself as a one-off menu entry. Kept as an informational wait, but backed
      // up with an unconditional Escape keypress right after, a generic and low-risk way to force-
      // close any lingering picker/modal regardless of its concrete DOM structure.
      await selectFromProfile
        .first()
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() =>
          console.error(
            '[jobup-cv-match] "Sélectionner depuis le profil" picker label did not report hidden within ' +
              '5s after attaching "' + fileName + '".'
          )
        );
      await applicationPage.keyboard.press('Escape').catch(() => {});
    } else {
      const buttonInfo = await applicationPage.getByRole('button').evaluateAll((els) =>
        els.slice(0, 30).map((el) => ({
          text: el.textContent?.trim().slice(0, 60),
          ariaLabel: el.getAttribute('aria-label')
        }))
      );
      console.error(
        '[jobup-cv-match] "Ajouter" confirm button not found for "' + fileName + '". Visible buttons:',
        JSON.stringify(buttonInfo)
      );
    }
  }
}

// Best-effort read of a toggle-like element's selected state via aria-pressed/aria-checked/
// aria-selected, checked on the element itself and up to 2 ancestors (jobup.ch's actual
// selected-state convention for these Yes/No options is unconfirmed live — this mirrors the
// aria-pressed pattern already confirmed for the job-page bookmark button elsewhere in this
// script). Returns true/false when a definite answer is found, or null when unknown.
async function isOptionSelected(locator) {
  return locator
    .evaluate((el) => {
      let node = el;
      for (let hop = 0; hop < 3 && node; hop++) {
        if (node.getAttribute) {
          for (const attr of ['aria-pressed', 'aria-checked', 'aria-selected']) {
            const value = node.getAttribute(attr);
            if (value === 'true') return true;
            if (value === 'false') return false;
          }
        }
        node = node.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

// Clicks every "Oui" option found on the page (one per required yes/no question) — always "Oui",
// per the user's explicit spec, regardless of what each question actually asks. Re-reads the count
// fresh (rather than snapshotting elements up front) since clicking one option can shift the DOM.
// Guards against re-clicking an "Oui" already detected as selected (which would risk toggling it
// back off), and makes a best-effort attempt to deselect a same-question "Non" first if one is
// found selected nearby. That "Non"-deselection part is speculative — unverified against jobup.ch's
// real markup for these questions (no live DOM evidence yet for a "Non" counterpart's structure or
// its container), so it's scoped to the option's own near ancestors only and never allowed to block
// selecting "Oui" if it can't cleanly find or click one.
async function answerYesNoQuestions(applicationPage) {
  const visible = applicationPage.locator(':visible');
  const ouiOptions = applicationPage.getByText('Oui', { exact: true }).and(visible);
  const count = await ouiOptions.count();
  console.error('[jobup-cv-match] found ' + count + ' "Oui" option(s) to select.');
  for (let i = 0; i < count; i++) {
    const ouiOption = ouiOptions.nth(i);
    try {
      const ouiSelected = await isOptionSelected(ouiOption);
      if (ouiSelected === true) {
        console.error('[jobup-cv-match] "Oui" option #' + (i + 1) + ' already selected; skipping.');
        continue;
      }

      let container = ouiOption;
      for (let hop = 0; hop < 2; hop++) {
        container = container.locator('xpath=..');
        const nonOption = container.getByText('Non', { exact: true }).and(visible).first();
        if (await nonOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          const nonSelected = await isOptionSelected(nonOption);
          if (nonSelected === true) {
            try {
              await nonOption.click();
              console.error(
                '[jobup-cv-match] deselected "Non" for question #' + (i + 1) + ' before selecting "Oui".'
              );
            } catch (err) {
              console.error(
                '[jobup-cv-match] could not deselect "Non" for question #' + (i + 1) + ':',
                err.message
              );
            }
          }
          break;
        }
      }

      await ouiOption.click();
    } catch (err) {
      console.error('[jobup-cv-match] could not click "Oui" option #' + (i + 1) + ':', err.message);
    }
  }
}

// Runs the whole draft-preparation sequence on the "Candidature simplifiée"/"Continuer ma
// candidature" tab: generate the cover letter if needed, attach the three standard documents if
// missing, answer every yes/no question "Oui", then "Sauvegarder" — never the final submit button.
async function fillApplicationDraft(applicationPage) {
  await generateCoverLetterIfNeeded(applicationPage);
  await attachMissingDocuments(applicationPage);
  await answerYesNoQuestions(applicationPage);

  // Unanchored (not /^sauvegarder$/i): confirmed live on the job page's own "Sauvegarder" button
  // that jobup.ch gives these an `aria-label` overriding the visible text (e.g. "Sauvegarder
  // l'emploi"), which an anchored exact-match regex misses entirely — this button may carry a
  // similarly enriched label, not yet confirmed live either way.
  const saveButton = applicationPage
    .getByRole('button', { name: /sauvegarder/i })
    .and(applicationPage.locator(':visible'));
  if (await saveButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
    // The job-page "Sauvegarder" click turned out to need its confirmation checked via the actual
    // network response rather than any DOM attribute (see prepareJobApplicationDraft()'s comment —
    // aria-pressed on the element that was actually clicked didn't reliably reflect a real,
    // server-confirmed save). This save-draft button's real endpoint isn't known yet, so rather than
    // guess one, every POST/PUT response seen during and shortly after the click is captured and
    // logged — the same evidence-gathering approach that identified the bookmark endpoint — so the
    // real one can be targeted precisely once a live run shows it.
    const capturedRequests = [];
    const onResponse = (res) => {
      const method = res.request().method();
      if (method === 'POST' || method === 'PUT') {
        capturedRequests.push(method + ' ' + res.status() + ' ' + res.url());
      }
    };
    applicationPage.on('response', onResponse);
    await saveButton.first().click();
    await applicationPage.waitForTimeout(2000);
    applicationPage.off('response', onResponse);
    console.error(
      '[jobup-cv-match] clicked "Sauvegarder" to save the application draft (not submitted). ' +
        'POST/PUT requests observed:',
      JSON.stringify(capturedRequests)
    );
  } else {
    console.error('[jobup-cv-match] "Sauvegarder" button not found on the application page; draft may not be saved.');
  }
}

// When the CV-match meter is green (a strong match), this saves the job and, if "Candidature
// simplifiée"/"Continuer ma candidature" is available, opens it (in a new tab — the same
// BrowserContext.waitForEvent('page') mechanism works fine for this within the same script/browser,
// no separate automation needed) and prepares (but never submits) a draft application there via
// fillApplicationDraft(). Never throws — a failure here shouldn't invalidate an already-successful
// CV-match analysis, so every step is defensive and just logs on failure. None of this has been
// verified against the live site (no jobup.ch session was available in this environment) — if a
// selector here doesn't match, re-derive it the documented way: dump the live DOM/ariaSnapshot
// rather than guessing again.
async function prepareJobApplicationDraft(page, meterColor, { saveJob, easyApply, ignoreYellowMeter }) {
  try {
    // Called whenever a meter is present at all (green or yellow) — see runCvMatch()'s call site
    // for why a missing meter ("Vos talents correspondent mieux à d'autres opportunités") skips
    // this function entirely. This first check handles the one remaining meter-based exclusion:
    // yellow specifically, only when the user has opted into treating it as not-good-enough.
    if (ignoreYellowMeter && meterColor === 'yellow') {
      console.error(
        '[jobup-cv-match] meter is yellow and "ignore yellow meter" is checked; not saving or applying.'
      );
      return;
    }

    // Confirmed live (user-supplied DOM snippet): this button's accessible name is actually
    // "Sauvegarder l'emploi", not "Sauvegarder" — it carries an `aria-label` that overrides its
    // visible text entirely for accessibility purposes, so the previous anchored
    // `getByRole('button', { name: /^sauvegarder$/i })` matched nothing (that regex requires the
    // *whole* accessible name to equal "Sauvegarder", not just contain it). Targeted here by its
    // stable `id`/`data-cy` first instead, per this file's usual "prefer data-cy" convention, with
    // an unanchored name regex as a last-resort fallback. It's also a toggle
    // (`aria-pressed="false"`/`"true"`, `data-cy="bookmark-button-unchecked"` when off) — guarded
    // so a job that's already saved from a previous run doesn't get un-saved by clicking it again.
    //
    // Confirmed live (second round): `#vacancy-bookmark-cta-info` matches *two* elements with the
    // same id — jobup.ch's usual habit of duplicating markup for responsive mobile/desktop layouts
    // (seen elsewhere in this file for job cards/the filter bar), just with a literally duplicated
    // id this time rather than a duplicated class. One instance resolves to a 0×0 box (its own
    // computed style still says `display:flex`/`visibility:visible` — it's an *ancestor* that's
    // actually hidden) even though the *element itself* isn't marked hidden, so `.first()` on the
    // unfiltered locator silently grabbed that one and `isVisible()` correctly reported false. Every
    // candidate below is now scoped to `:visible` so only the real, on-screen instance matches.
    //
    // Confirmed live (third round): jobup.ch also has a *second*, unrelated bookmark control for
    // this exact job — a compact icon-only button (`id="vacancy-bookmark-icon-<jobId>"`,
    // `data-cy="bookmark-icon-unchecked"`, no visible text) that carries the *same*
    // `aria-label="Sauvegarder l'emploi"` as the intended `#vacancy-bookmark-cta-info` CTA. The
    // previous version combined both candidates with `.or()` — a union, not a priority order — so
    // `.first()` picked whichever of the two happened to come first in DOM order, non-deterministically
    // landing on the icon variant instead. Its click DID reach jobup.ch's server (confirmed live: the
    // resulting `POST /api/v1/user/bookmark/job` returned 200) — the save genuinely worked — but its
    // own `aria-pressed` apparently isn't kept in sync reactively, which is exactly why the previous
    // aria-pressed-polling confirmation kept reporting failure on an actual success. Fixed two ways:
    // (1) candidates are now tried in strict priority order (first visible one wins, not a union), so
    // the specific, confirmed-correct `#vacancy-bookmark-cta-info` is used whenever it's present at
    // all, and (2) success is confirmed via the actual `POST .../bookmark/job` response status — the
    // real, server-side ground truth — rather than trusting any particular button's DOM attribute.
    if (!saveJob) {
      console.error('[jobup-cv-match] "Save job" is unchecked; not clicking "Sauvegarder".');
    } else {
      let saveButton = null;
      for (const candidate of [
        page.locator('#vacancy-bookmark-cta-info:visible'),
        page.locator('[data-cy="bookmark-button-unchecked"]:visible, [data-cy="bookmark-button-checked"]:visible'),
        page.getByRole('button', { name: /sauvegarder/i }).and(page.locator(':visible'))
      ]) {
        if (await candidate.first().isVisible({ timeout: 5000 }).catch(() => false)) {
          saveButton = candidate.first();
          break;
        }
      }

      if (saveButton) {
        const alreadySaved = (await saveButton.getAttribute('aria-pressed').catch(() => null)) === 'true';
        if (alreadySaved) {
          console.error('[jobup-cv-match] job is already saved (aria-pressed="true"); not toggling it off.');
        } else {
          const [bookmarkResponse] = await Promise.all([
            page
              .waitForResponse(
                (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/user/bookmark/job'),
                { timeout: 8000 }
              )
              .catch(() => null),
            saveButton.click()
          ]);

          if (bookmarkResponse && bookmarkResponse.ok()) {
            console.error(
              '[jobup-cv-match] clicked "Sauvegarder" (save job) — confirmed via POST ' +
                '/api/v1/user/bookmark/job returning ' + bookmarkResponse.status() + '.'
            );
            // Small buffer past the confirmed response so any client-side state update it triggers has
            // time to settle before this run moves on.
            await page.waitForTimeout(500);
          } else {
            console.error(
              '[jobup-cv-match] clicked "Sauvegarder" but no successful POST to /api/v1/user/bookmark/job ' +
                'was observed within 8s' +
                (bookmarkResponse ? ' (got status ' + bookmarkResponse.status() + ')' : '') +
                ' — the save may not have registered.'
            );
          }
        }
      } else {
        console.error('[jobup-cv-match] "Sauvegarder" button not found/visible on the job page; skipping.');
      }
    }

    if (!easyApply) {
      console.error('[jobup-cv-match] "Easy apply" is unchecked; not preparing an application draft.');
      return;
    }

    const applyButton = page
      .getByRole('button', { name: /candidature simplifiée|continuer ma candidature/i })
      .and(page.locator(':visible'));
    const applyButtonVisible = await applyButton.first().isVisible({ timeout: 10000 }).catch(() => false);
    if (!applyButtonVisible) {
      // Confirmed live: a job posted via an external/agency application flow (e.g. a staffing
      // agency) has no "Candidature simplifiée"/"Continuer ma candidature" button at all — its only
      // apply control is `[data-cy="apply-button-external"]` ("Postuler"), which redirects off
      // jobup.ch entirely. That's an expected, unsupported case (there's no on-site draft to
      // prepare), distinct from a genuinely missing/renamed button — logged differently so it's not
      // mistaken for a bug.
      const isExternalApply = await page
        .locator('[data-cy="apply-button-external"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (isExternalApply) {
        console.error(
          '[jobup-cv-match] this job only offers an external application ("Postuler", ' +
            'data-cy="apply-button-external") — no on-site "Candidature simplifiée" flow to prepare a draft in.'
        );
      } else {
        console.error(
          '[jobup-cv-match] no "Candidature simplifiée"/"Continuer ma candidature" button found; ' +
            'skipping application draft.'
        );
      }
      return;
    }

    const [applicationPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 20000 }),
      applyButton.first().click()
    ]);
    await applicationPage.waitForLoadState('domcontentloaded');
    console.error('[jobup-cv-match] opened the application page in a new tab:', applicationPage.url());

    try {
      await fillApplicationDraft(applicationPage);
    } finally {
      await applicationPage.close();
    }
  } catch (err) {
    console.error('[jobup-cv-match] error while preparing the application draft (analysis result is unaffected):', err);
  }
}

async function runCvMatch(
  email,
  password,
  jobIndex,
  useBasicSearch,
  searchTerm,
  locations,
  saveJob,
  easyApply,
  ignoreYellowMeter
) {
  // Falls back to the fixed defaults whenever the caller-supplied value is empty/blank — see the
  // header comment and the individual usages below for why `effectiveSearchTerm` only ever gets
  // used on paths where "Rechercher avec mon profil" wasn't available in the first place.
  const effectiveSearchTerm = searchTerm && searchTerm.trim() ? searchTerm.trim() : RECOVERY_SEARCH_TERM;
  const filteredLocations = (Array.isArray(locations) ? locations : [])
    .map((location) => String(location).trim())
    .filter((location) => location.length > 0);
  const effectiveLocations = filteredLocations.length > 0 ? filteredLocations : [LOCATION_SLUG];

  const browser = await chromium.launch();
  // Declared here (not just inside the try) so the catch block below can still read page.url() for
  // resultsUrl when an EmptyResultsError is thrown — a `const` declared inside the try body isn't
  // visible from its own catch block.
  let page;
  try {
    // Explicit desktop-sized viewport rather than Playwright's default (1280x720 headless) — two
    // separate confirmed-live bugs now (the job-page "Sauvegarder" button's duplicated markup, see
    // CLAUDE.md) have come from jobup.ch rendering a different responsive layout than whatever this
    // script's headless browser happened to fall into, vs. what a live DOM dump taken from a normal
    // full-size browser window showed. A larger, fixed viewport keeps the desktop layout consistent
    // regardless of Playwright's own headless default, so this class of mismatch doesn't recur.
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('https://www.jobup.ch/fr/');

    await dismissCookieConsent(page);

    const loggedIn = await performLogin(page, email, password);
    if (!loggedIn) {
      // No search was ever run, so there's no results URL to report yet.
      return {
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount: null,
        errorMessage: null,
        resultsUrl: null
      };
    }

    await page.goto('https://www.jobup.ch/fr/emplois/');

    // The accessible name "Rechercher avec mon profil" also matches a second, nested button
    // inside the "Ouvrir Recherche" search-bar dropdown (data-cy="search-with-profile-button-row"),
    // which made a plain role/name locator ambiguous (Playwright strict-mode violation) the first
    // time this was verified live, so the primary path targets the standalone page CTA by its
    // data-cy attribute. That CTA (and even a plain role/name match) has occasionally been observed
    // missing within the previous, shorter wait window even in the same account/session where it
    // worked moments before — most likely page-load timing jitter rather than a real UI change, so
    // it now gets a longer window before falling back. If it's genuinely absent (e.g. once the
    // account accumulates enough search/application history that jobup.ch permanently swaps
    // `/fr/emplois/` for a candidate-dashboard sub-nav — `data-cy="vacancy-search-sub-nav"`, tabs
    // "Recherche d'emploi" / "Recommandations d'emploi" / "Job Alerte" / "Emplois sauvegardés" /
    // "Candidatures" — with no "Rechercher avec mon profil" text anywhere), the sub-nav's "Recherche
    // d'emploi" tab is tried as a last resort. Confirmed live: that tab can land in either
    // "Intelligent search" mode (a free-text "Décris ton rôle idéal :" box) or "Basic search" mode
    // (the classic "Villes ou régions" filter UI) depending on persisted account/browser state —
    // the mode-detection right after the click below handles both.
    const searchWithProfileByDataCy = page.locator('[data-cy="search-with-profile-button-cta"]');
    const searchWithProfileByRole = page.getByRole('button', { name: /rechercher avec mon profil/i });
    const jobSearchTab = page.locator('[data-cy="vacancy-search-sub-nav"]').getByText(/recherche d'emploi/i).first();

    async function dumpSubNavAndThrow(waitErr, alsoTried) {
      const subNavContent = await page
        .locator('[data-cy="vacancy-search-sub-nav"]')
        .evaluateAll((els) => els.map((el) => el.innerText));
      console.error(
        '[jobup-cv-match] could not find' + (alsoTried ? ' ' + alsoTried + ', nor' : '') +
          ' "Recherche d\'emploi" in vacancy-search-sub-nav. Its content:',
        JSON.stringify(subNavContent)
      );
      throw waitErr;
    }

    let searchWithProfileButton;
    let searchWithProfilePath;
    if (useBasicSearch) {
      // "Use basic search" checked on the frontend: skip the profile-based CTA entirely and go
      // straight for the sub-nav's "Recherche d'emploi" tab, the same entry point the natural
      // fallback below uses — mainly useful for exercising/testing that path (and the "Aller à la
      // recherche basique" recovery it leads into) directly, without depending on account state.
      try {
        await jobSearchTab.waitFor({ state: 'visible', timeout: 15000 });
        searchWithProfileButton = jobSearchTab;
        searchWithProfilePath = 'subNavTab (forced by useBasicSearch)';
      } catch (waitErr) {
        await dumpSubNavAndThrow(waitErr);
      }
    } else {
      // The accessible name "Rechercher avec mon profil" also matches a second, nested button
      // inside the "Ouvrir Recherche" search-bar dropdown (data-cy="search-with-profile-button-row"),
      // which made a plain role/name locator ambiguous (Playwright strict-mode violation) the first
      // time this was verified live, so the primary path targets the standalone page CTA by its
      // data-cy attribute. That CTA (and even a plain role/name match) has occasionally been observed
      // missing within the previous, shorter wait window even in the same account/session where it
      // worked moments before — most likely page-load timing jitter rather than a real UI change, so
      // it now gets a longer window before falling back. If it's genuinely absent (e.g. once the
      // account accumulates enough search/application history that jobup.ch permanently swaps
      // `/fr/emplois/` for a candidate-dashboard sub-nav — `data-cy="vacancy-search-sub-nav"`, tabs
      // "Recherche d'emploi" / "Recommandations d'emploi" / "Job Alerte" / "Emplois sauvegardés" /
      // "Candidatures" — with no "Rechercher avec mon profil" text anywhere), the sub-nav's "Recherche
      // d'emploi" tab is tried as a last resort. Confirmed live: that tab can land in either
      // "Intelligent search" mode (a free-text "Décris ton rôle idéal :" box) or "Basic search" mode
      // (the classic "Villes ou régions" filter UI) depending on persisted account/browser state —
      // the mode-detection right after the click below handles both.
      try {
        await searchWithProfileByDataCy.waitFor({ state: 'visible', timeout: 25000 });
        searchWithProfileButton = searchWithProfileByDataCy;
        searchWithProfilePath = 'cta';
      } catch {
        try {
          await searchWithProfileByRole.last().waitFor({ state: 'visible', timeout: 15000 });
          searchWithProfileButton = searchWithProfileByRole.last();
          searchWithProfilePath = 'role';
        } catch {
          try {
            await jobSearchTab.waitFor({ state: 'visible', timeout: 10000 });
            searchWithProfileButton = jobSearchTab;
            searchWithProfilePath = 'subNavTab';
            console.error('[jobup-cv-match] falling back to the "Recherche d\'emploi" sub-nav tab.');
          } catch (waitErr) {
            await dumpSubNavAndThrow(waitErr, '"Rechercher avec mon profil"');
          }
        }
      }
    }

    console.error('[jobup-cv-match] entered search flow via path:', searchWithProfilePath);
    await searchWithProfileButton.click();

    // Declared up front (not just plain values yet — Playwright locators are lazy, they don't
    // require the page to be in any particular state until actually awaited) so the recovery
    // branch below can use waitForJobResults() after a direct URL navigation, same as the
    // location-filtering step further down.
    const dataCyJobLinks = page.locator('[data-cy="job-link"]:visible');
    const articleJobLinks = page.getByRole('article');
    const anyJobResult = dataCyJobLinks.or(articleJobLinks);

    // jobup.ch's `/fr/emplois/` page can independently load in "Intelligent search" mode (the
    // AI free-text "Décris ton rôle idéal :" UI) or "Basic search" mode (the classic, filter-based
    // UI with "Villes ou régions" etc.) — confirmed live this isn't strictly tied to which entry
    // point above was used (e.g. the sub-nav tab can land directly in either one, apparently
    // depending on persisted account/browser state). Whichever mode you're *not* currently in
    // offers a link to switch to the other, and those two links are mutually exclusive — only one
    // is ever present — so their presence is used below to detect the current mode directly,
    // rather than assuming it from searchWithProfilePath.
    // Confirmed live via a user-supplied DOM dump: these aren't real <a>/<button> elements, just
    // a <span role="button" tabindex="0"> wrapping the label text in its own nested <span> (plus
    // an aria-hidden icon) — getByRole('button', ...) does match an explicit role="button" like
    // this, but a getByText fallback is added too in case role-matching is ever flaky for it.
    const goToIntelligentSearchLink = page
      .getByRole('link', { name: /aller à la recherche intelligente/i })
      .or(page.getByRole('button', { name: /aller à la recherche intelligente/i }))
      .or(page.getByText('Aller à la recherche intelligente', { exact: true }));
    const basicSearchLink = page
      .getByRole('link', { name: /aller à la recherche basique/i })
      .or(page.getByRole('button', { name: /aller à la recherche basique/i }))
      .or(page.getByText('Aller à la recherche basique', { exact: true }));

    // Clicks the given "go to X mode" link if present, otherwise assumes that mode's already
    // active. Returns whether a click happened. 10s default — this link has been observed slow to
    // render right after the sub-nav-tab click, same as other elements on this page (see the
    // "Rechercher avec mon profil" gotcha's longer waits).
    async function switchModeIfLinkPresent(link, timeout = 10000) {
      const present = await link
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
      if (present) {
        await link.first().click();
      }
      return present;
    }

    // Despite the name (kept for continuity with earlier logs/docs), this now just means "fill
    // RECOVERY_SEARCH_TERM into whatever term field is present" — it no longer implies Basic
    // search mode specifically, since the natural sub-nav-tab fallback below can set it while
    // staying in Intelligent search mode.
    let usedBasicSearchRecovery = false;
    // Set when the recovery branch below navigates directly via URL instead of filling a term
    // field and clicking "Recherche" through the UI — see why in that branch's comment.
    let skipSearchSubmit = false;

    if (useBasicSearch) {
      // "Use basic search" checked: go straight to Basic search mode (click "Aller à la
      // recherche basique" if needed, no-op if already there) and use RECOVERY_SEARCH_TERM —
      // this is the explicit request for the basic-search flow, no CTA detour.
      const switched = await switchModeIfLinkPresent(basicSearchLink, 10000);
      console.error(
        switched
          ? '[jobup-cv-match] useBasicSearch: clicked "Aller à la recherche basique".'
          : '[jobup-cv-match] useBasicSearch: already in Basic search mode (or the link was not ' +
              'found); proceeding directly.'
      );
      usedBasicSearchRecovery = true;
    } else if (searchWithProfilePath.startsWith('subNavTab')) {
      // Natural fallback (CTA/role unavailable on the initial page): the sub-nav tab can land on
      // whichever mode the account/browser currently defaults to, not necessarily Basic search
      // mode. Ensure Intelligent search mode first (no-op if already there) and look there for
      // "Rechercher avec mon profil" — reusing the profile-matched CTA flow gives a real
      // profile-derived search term instead of RECOVERY_SEARCH_TERM, so it's preferred here.
      const switchedToIntelligent = await switchModeIfLinkPresent(goToIntelligentSearchLink);
      console.error(
        switchedToIntelligent
          ? '[jobup-cv-match] entered via the sub-nav tab; clicked "Aller à la recherche intelligente".'
          : '[jobup-cv-match] entered via the sub-nav tab, already in Intelligent search mode (or the ' +
              'link was not found).'
      );
      if (!switchedToIntelligent) {
        // Diagnostic only, not a failure path: dump what role="button"/role="link" elements
        // actually exist right now, to see why the "Aller à la recherche intelligente" locator
        // didn't match one even though a live DOM dump showed it present as a
        // <span role="button"> elsewhere.
        const candidates = await page
          .locator('[role="button"], [role="link"], a, button')
          .evaluateAll((els) =>
            els
              .filter((el) => el.textContent && /intelligente|basique/i.test(el.textContent))
              .map((el) => ({
                tag: el.tagName,
                role: el.getAttribute('role'),
                text: el.textContent.trim().slice(0, 80),
                visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
              }))
          );
        console.error(
          '[jobup-cv-match] mode-switch link not matched; elements mentioning intelligente/basique:',
          JSON.stringify(candidates)
        );
      }

      // Same ambiguous-accessible-name issue as searchWithProfileByRole above — this also matches
      // the hidden nested button inside the "Ouvrir Recherche" dropdown, so the standalone CTA
      // (data-cy first, role .last() as fallback) is targeted the same way, not .first().
      const profileButtonByDataCyInIntelligentMode = page.locator('[data-cy="search-with-profile-button-cta"]');
      const profileButtonByRoleInIntelligentMode = page.getByRole('button', { name: /rechercher avec mon profil/i });
      let profileButtonInIntelligentMode = null;
      if (
        await profileButtonByDataCyInIntelligentMode
          .waitFor({ state: 'visible', timeout: 10000 })
          .then(() => true)
          .catch(() => false)
      ) {
        profileButtonInIntelligentMode = profileButtonByDataCyInIntelligentMode;
      } else if (
        await profileButtonByRoleInIntelligentMode
          .last()
          .waitFor({ state: 'visible', timeout: 5000 })
          .then(() => true)
          .catch(() => false)
      ) {
        profileButtonInIntelligentMode = profileButtonByRoleInIntelligentMode.last();
      }
      const foundProfileButton = profileButtonInIntelligentMode !== null;

      if (foundProfileButton) {
        console.error(
          '[jobup-cv-match] entered via the sub-nav tab; found "Rechercher avec mon profil" in ' +
            'Intelligent search mode, using the same flow as the direct-CTA path from here.'
        );
        await profileButtonInIntelligentMode.click();
        searchWithProfilePath = 'cta (via subNavTab detour)';
      } else {
        // Confirmed live via a user-supplied screenshot: Intelligent search mode's own term/
        // location fields work fine with a manually-typed term (not just a profile-derived one),
        // and its results are broader than Basic search mode's for the same term/location — so
        // this deliberately stays in Intelligent search mode rather than switching to Basic search
        // mode (which an earlier version of this code did, needlessly narrowing the results).
        // But confirmed live, staying here and trying to fill a term field through the UI (the
        // way the old Basic-search recovery did) doesn't reliably work: the landing state right
        // after entering via the sub-nav tab can be the true free-text AI page (no matching
        // input/combobox/textbox at all, and no "Recherche" button either — not the term+location
        // dual-field layout the screenshot showed, which is what you get once a search has
        // actually been run). So skip UI interaction entirely here and navigate straight to the
        // results URL with `term`/`location` query params set, the same reliable mechanism
        // already used for location filtering and pagination elsewhere in this file.
        console.error(
          '[jobup-cv-match] entered via the sub-nav tab; "Rechercher avec mon profil" not available ' +
            'in Intelligent search mode either, navigating directly to the Intelligent-search results ' +
            'URL with the effective search term/locations instead of filling fields through the UI.'
        );
        const recoveryUrl = new URL(page.url());
        recoveryUrl.searchParams.set('term', effectiveSearchTerm);
        appendLocations(recoveryUrl, effectiveLocations);
        await page.goto(recoveryUrl.toString());
        await waitForJobResults(page, anyJobResult, '1 (recovery term+location via URL)');
        skipSearchSubmit = true;
      }
    }

    // On the basic-search recovery UI, fill in the effective search term so the search isn't
    // unfiltered by keyword. Confirmed live: this field has no placeholder/aria-label/name at all
    // — just `id="synonym-typeahead-text-field"`. Not fatal if it can't be found/filled — the run
    // still proceeds, just unfiltered by keyword. Skipped entirely when skipSearchSubmit is set —
    // the recovery branch above already navigated directly with the term (and location) as URL
    // query params instead.
    if (usedBasicSearchRecovery && !skipSearchSubmit) {
      const termField = page
        .locator('#synonym-typeahead-text-field')
        .or(page.getByPlaceholder(/poste|mot.?cl[ée]|m[ée]tier|fonction/i))
        .or(page.getByRole('combobox', { name: /poste|mot.?cl[ée]|m[ée]tier|fonction/i }))
        .or(page.getByRole('textbox', { name: /poste|mot.?cl[ée]|m[ée]tier|fonction/i }));

      try {
        await termField.first().waitFor({ state: 'visible', timeout: 8000 });
        await termField.first().fill(effectiveSearchTerm);
        // Filling a typeahead field like this one opens its own suggestions dropdown; Escape
        // dismisses it without picking a suggestion, keeping the typed term.
        await termField.first().press('Escape');
        console.error('[jobup-cv-match] filled the basic-search term field with "' + effectiveSearchTerm + '".');
      } catch {
        const fields = await page.locator('input, [role="combobox"], [role="searchbox"]').evaluateAll((els) =>
          els.map((el) => ({
            tag: el.tagName,
            id: el.id,
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            name: el.getAttribute('name'),
          }))
        );
        console.error(
          '[jobup-cv-match] could not find a term field on the basic-search UI to fill; proceeding ' +
            'unfiltered by keyword. Available inputs:',
          JSON.stringify(fields)
        );
      }
    }

    if (!skipSearchSubmit) {
      await page.getByRole('button', { name: /^recherche$/i }).click();
    }

    // Select the inPageIndex-th (1-based) job offer on the current results page, in the order the
    // job cards actually appear in the DOM. On the direct-CTA search UI, confirmed live: no
    // `role="article"` elements and no `a[href*="/emploi/"]` links exist, but each job card has
    // `data-cy="job-link"`. That plain attribute selector's `.count()`/`.nth()` follow document
    // order (like `querySelectorAll`) and the `:visible` filter guards against jobup.ch's habit of
    // duplicating markup for responsive mobile/desktop layouts (seen elsewhere on this page)
    // inflating the count with hidden duplicates — but confirmed live, the "Aller à la recherche
    // basique" recovery path can land on a *different* results UI variant that uses `role="article"`
    // cards instead (zero `data-cy="job-link"` there), so which pattern is actually in play is
    // decided after arriving at the target page below, not assumed up front. dataCyJobLinks/
    // articleJobLinks/anyJobResult were declared earlier (right after entering the search flow) so
    // the recovery branch above could also use them; these locators stay valid across the
    // pagination clicks below regardless (Playwright locators re-query the live DOM on each use,
    // they aren't snapshotted at creation time).

    // Wait for page 1's results to actually render before reading the URL below — jobup.ch syncs
    // it (adding the real `term`) asynchronously after "Recherche"; reading it too early was
    // confirmed live to capture a stale/bare `term=` (see CLAUDE.md's pagination gotcha, which hit
    // the exact same issue for a different reason) and lock that in permanently once we navigate
    // again below. Skipped when skipSearchSubmit is set — the recovery branch above already waited
    // for results after its own direct navigation.
    if (!skipSearchSubmit) {
      await waitForJobResults(page, anyJobResult, '1');
    }

    // Applying "Utiliser ma localisation" by clicking through jobup.ch's own UI proved unreliable
    // on both search-entry paths — see CLAUDE.md's location-widget gotcha for the full history
    // (two different widgets depending on entry path, one needing `force: true` due to an unrelated
    // interception, values reverting to empty shortly after a seemingly successful selection, etc.
    // — the underlying location filter frequently never actually reached the final search).
    // Confirmed live instead: `location=<slug>` is a real, server-recognized query param —
    // appending it to the results URL and navigating there returns genuinely filtered, exactly
    // accurate results (e.g. `totalJobsCount: 17`, matching the real expected count) on the
    // basic-search recovery path specifically.
    //
    // This does NOT work on the direct-CTA path, though: confirmed live, re-navigating that same
    // page via `page.goto()` to add `location=...` reliably triggers ERR_TOO_MANY_REDIRECTS, even
    // with a drastically shortened `term` (ruling out URL length as the cause) — a genuine
    // CTA-session/page incompatibility with fresh navigation (matching the earlier `page=N`
    // pagination finding), not something fixable by adjusting the URL. The click-based dropdown
    // selection that used to run here didn't error on that path, but also never demonstrably
    // applied a real filter (results stayed at unfiltered-by-location levels), so — rather than
    // keep code that looks like it does something but doesn't — the direct-CTA path is left
    // unfiltered by location for now. **Known limitation**: use `useBasicSearch` (the frontend's
    // "Use basic search" checkbox) for a location-filtered search; the direct-CTA path's results
    // are profile/term-matched but not location-narrowed.
    if (searchWithProfilePath.startsWith('subNavTab')) {
      const locationUrl = new URL(page.url());
      if (!locationUrl.searchParams.get('location')) {
        appendLocations(locationUrl, effectiveLocations);
        await page.goto(locationUrl.toString());
        // Fresh navigation — wait for its results to render too, same reasoning as above.
        await waitForJobResults(page, anyJobResult, '1 (with location)');
      }
    } else {
      console.error(
        '[jobup-cv-match] direct-CTA path: skipping location filtering (known unresolved limitation ' +
          '— see CLAUDE.md); results below are not location-filtered.'
      );
    }

    // The total match count ("<N> offres d'emploi") appears as text near the top of the results
    // page and stays constant across pagination, so it's read once here. Not critical to the rest
    // of the flow — if it can't be found/parsed, this just logs and moves on with `null` rather
    // than failing the whole run over a supplementary piece of information.
    let totalJobsCount = null;
    try {
      const jobCountText = await page.getByText(/[\d'.,\s]+offres? d'emploi/i).first().textContent({ timeout: 10000 });
      const digits = (jobCountText.match(/[\d'.,\s]+(?=offres? d'emploi)/i) || [])[0];
      const parsed = digits ? Number(digits.replace(/\D/g, '')) : NaN;
      totalJobsCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      console.error('[jobup-cv-match] could not find/parse the "... offres d\'emploi" total job-count text.');
    }

    // Confirmed live: that "... offres d'emploi" text can be wrong on a small result set (seen:
    // parsed as 1 while 3 distinct job cards actually rendered on the page) — the text apparently
    // reflects a different count than what's actually rendered in this case. Whenever the parsed
    // total is small enough that every match fits on this one page (<= JOBS_PER_PAGE, so no
    // pagination is involved and every matching card is already in the DOM right here), the actual
    // rendered job cards are counted directly and trusted over that text instead. Above
    // JOBS_PER_PAGE this isn't attempted — counting DOM elements only tells you what's on *this*
    // page, not the true total across every page, so the parsed text remains the only total on hand.
    if (totalJobsCount !== null && totalJobsCount <= JOBS_PER_PAGE) {
      const dataCyElements = await dataCyJobLinks.all();
      const jobElements = dataCyElements.length > 0 ? dataCyElements : await articleJobLinks.all();
      const hrefs = await Promise.all(jobElements.map((el) => el.getAttribute('href')));
      const { deduped } = dedupeByHref(jobElements.map((el, i) => ({ href: hrefs[i] })));
      if (deduped.length !== totalJobsCount) {
        console.error(
          '[jobup-cv-match] "... offres d\'emploi" text said ' + totalJobsCount + ' but ' +
            deduped.length + ' distinct job card(s) are actually rendered on this page — using the ' +
            'DOM count instead.'
        );
        totalJobsCount = deduped.length;
      }
    }

    // Logged unconditionally for visibility into which search path was used and what it actually
    // found — e.g. to confirm the RECOVERY_SEARCH_TERM fill above landed a reasonably-scoped
    // totalJobsCount rather than the ~36000 (location-filtered only) seen before that fill existed,
    // and — since the pill-trigger widget's own input value isn't a reliable success signal (see
    // CLAUDE.md) — to confirm from the results URL's `location` param whether the location filter
    // actually took effect on either path, independent of that widget's client-side state.
    const resultsUrlLocationParam = (() => {
      try {
        return new URL(page.url()).searchParams.get('location');
      } catch {
        return null;
      }
    })();
    console.error(
      '[jobup-cv-match] totalJobsCount:', totalJobsCount,
      'search entry path:', searchWithProfilePath,
      'location param:', JSON.stringify(resultsUrlLocationParam),
      'results URL:', page.url()
    );

    // Validated here rather than before the search even ran, so an invalid jobIndex still reports
    // totalJobsCount — knowing how many jobs the search itself found is useful context even when
    // the requested index was never going to be valid.
    if (!Number.isInteger(jobIndex) || jobIndex < 1) {
      console.error('[jobup-cv-match] jobIndex ' + jobIndex + ' must be a positive integer.');
      return {
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount,
        errorMessage: 'Job index must be a positive integer',
        resultsUrl: page.url()
      };
    }

    // jobup.ch paginates results at JOBS_PER_PAGE (20) per page. jobIndex 1-20 is on page 1
    // (where we already are); anything beyond that requires paging forward to reach it.
    // `inPageIndex` is that job's 1-based position *within* its page —
    // `((jobIndex - 1) % JOBS_PER_PAGE) + 1` rather than the simpler `jobIndex % JOBS_PER_PAGE`,
    // since the latter gives 0 (invalid) for exact multiples of JOBS_PER_PAGE (e.g. jobIndex 40
    // should be position 20 on page 2, not position 0).
    //
    const targetPage = Math.ceil(jobIndex / JOBS_PER_PAGE);
    const inPageIndex = ((jobIndex - 1) % JOBS_PER_PAGE) + 1;

    if (targetPage > 1 && searchWithProfilePath.startsWith('subNavTab')) {
      // Confirmed live `location=<slug>` works as a direct URL navigation specifically on this
      // path (see the location-filtering gotcha above), unlike the direct-CTA path's session state,
      // which reliably breaks it — worth testing whether `page=N` does too, since the original
      // ERR_TOO_MANY_REDIRECTS finding for `page=N` below was only ever confirmed on the CTA path.
      // Confirmed live it does: no redirect loop, correct page's results render.
      const pagedUrl = new URL(page.url());
      pagedUrl.searchParams.set('page', String(targetPage));
      await page.goto(pagedUrl.toString());
      await waitForJobResults(page, anyJobResult, targetPage + ' (via page= param)');
    } else {
      // Confirmed live: appending `&page=N` to the results URL and hard-navigating there
      // (`page.goto`) doesn't work on the direct-CTA path — that path's session/routing state
      // makes the browser hit ERR_TOO_MANY_REDIRECTS (see the location-filtering gotcha above for
      // the same finding, confirmed not to be a URL-length issue). Pagination has to happen
      // client-side there instead, the way a real user would: by clicking a "next page" control
      // repeatedly. Its exact accessible name hasn't been confirmed live yet, so this tries a
      // couple of plausible ones and dumps pagination-area candidates to stderr if none match.
      for (let currentPage = 1; currentPage < targetPage; currentPage++) {
        const nextPageControl = page
          .getByRole('link', { name: /suivant|next/i })
          .or(page.getByRole('button', { name: /suivant|next/i }));

        try {
          await nextPageControl.first().waitFor({ state: 'visible', timeout: 10000 });
        } catch (waitErr) {
          const paginationCandidates = await page
            .locator('[data-cy*="pag" i], nav, [aria-label*="pagination" i], [role="navigation"]')
            .evaluateAll((els) =>
              els.slice(0, 10).map((el) => ({
                tag: el.tagName,
                dataCy: el.getAttribute('data-cy'),
                ariaLabel: el.getAttribute('aria-label'),
                text: el.textContent?.trim().slice(0, 150),
              }))
            );
          console.error(
            '[jobup-cv-match] could not find a "next page" control going from page ' + currentPage +
              ' to ' + targetPage + '. Pagination-area candidates:',
            JSON.stringify(paginationCandidates)
          );
          throw waitErr;
        }

        await nextPageControl.first().click();
        await waitForJobResults(page, anyJobResult, String(currentPage + 1));
      }
    }

    // Decide which pattern is actually present on the page we landed on (see comment above) —
    // don't assume it matches whatever pattern was seen on page 1. Locator/DOM order also isn't
    // guaranteed to match the jobs' actual top-to-bottom order on the page — jobup.ch's list could
    // virtualize or otherwise reorder cards in the DOM independent of how they're laid out visually
    // — so sort by each element's real on-screen position (bounding box) instead of trusting
    // `.nth()`. jobup.ch has no known position/index attribute to read this from directly (nothing
    // like `data-index`/`aria-posinset` seen in any of the live dumps so far), so this measures it
    // directly.
    async function measureJobs() {
      const dataCyElements = await dataCyJobLinks.all();
      const jobElements = dataCyElements.length > 0 ? dataCyElements : await articleJobLinks.all();
      const jobsWithPosition = await Promise.all(
        jobElements.map(async (el) => ({ el, box: await el.boundingBox(), href: await el.getAttribute('href') }))
      );
      const { deduped, duplicateHrefs } = dedupeByHref(
        jobsWithPosition
          .filter((j) => j.box !== null)
          .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      );
      if (duplicateHrefs.length > 0) {
        console.error(
          '[jobup-cv-match] found ' + duplicateHrefs.length + ' duplicate job-link element(s) on page ' +
            targetPage + ' (same href, different position — likely a promotional/recommended widget ' +
            'reusing the same data-cy) — deduped:',
          JSON.stringify(duplicateHrefs)
        );
      }
      return {
        usedArticleFallback: dataCyElements.length === 0,
        dropped: jobsWithPosition.filter((j) => j.box === null),
        sorted: deduped,
      };
    }

    let measured = await measureJobs();

    // Confirmed live: right after paginating, every matched job element can briefly resolve with a
    // null boundingBox() at once — hrefs already present, elements already matched by the locator,
    // just still mid-render/settling — which previously got misread as "0 jobs on this page" (an
    // out-of-range jobIndex) rather than the transient state it actually was. Retry the measurement
    // a few times before trusting a fully-dropped result.
    for (let attempt = 0; measured.sorted.length === 0 && measured.dropped.length > 0 && attempt < 3; attempt++) {
      console.error(
        '[jobup-cv-match] all ' + measured.dropped.length + ' matched job element(s) on page ' + targetPage +
          ' had no bounding box (likely still rendering) — retrying measurement (attempt ' + (attempt + 1) + ').'
      );
      await page.waitForTimeout(750);
      measured = await measureJobs();
    }

    if (measured.usedArticleFallback) {
      console.error(
        '[jobup-cv-match] no [data-cy="job-link"] elements on page ' + targetPage +
          '; using role="article" for job selection instead.'
      );
    }

    const { dropped, sorted } = measured;

    // Logged unconditionally (not just on error) so a *wrong* selection — not just a missing one —
    // can be diagnosed from the resulting order and each element's href/coordinates, e.g. an
    // off-screen duplicate (a hidden mobile/desktop responsive twin, per the filter-bar gotcha)
    // still passing the `:visible` check and skewing the sort.
    console.error(
      '[jobup-cv-match] job order on page ' + targetPage + ':',
      JSON.stringify(sorted.map((j, i) => ({ position: i + 1, href: j.href, x: j.box.x, y: j.box.y }))),
      dropped.length ? 'dropped (no bounding box, href): ' + JSON.stringify(dropped.map((j) => j.href)) : ''
    );

    const orderedJobs = sorted.map((j) => j.el);

    const jobCount = orderedJobs.length;
    if (inPageIndex > jobCount) {
      console.error(
        '[jobup-cv-match] jobIndex ' + jobIndex + ' (page ' + targetPage + ', position ' + inPageIndex +
          ') is out of range for ' + jobCount + ' job(s) found on that page.'
      );
      return {
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount,
        errorMessage: 'Job index must not be greater than the number of jobs found on that page',
        resultsUrl: page.url()
      };
    }

    const selectedJob = orderedJobs[inPageIndex - 1];

    // The results *listing* page's own URL (term/location/page=N query params, no `?jobid=...`
    // yet) — captured here, before clicking the job, so it reflects the actual page the job was
    // found/selected on rather than whatever state the click below (and the analysis dialog it
    // opens) leaves the URL in.
    const resultsUrl = page.url();

    // Read the job's real detail URL (https://www.jobup.ch/fr/emplois/detail/...) from the link's
    // own `href` before clicking — jobup.ch renders the job detail in place rather than navigating
    // (it just adds a `?jobid=...` query param to the *current*, listing URL), so `page.url()`
    // after the click is the search page, not the job. `[data-cy="job-link"]` is the `<a>` itself
    // on the confirmed-good path, but fall back to a nested `a[href]` in case the `role="article"`
    // fallback locator ever matches instead.
    let jobHref = await selectedJob.getAttribute('href');
    if (!jobHref) {
      jobHref = await selectedJob.locator('a[href]').first().getAttribute('href').catch(() => null);
    }
    const jobUrl = jobHref ? new URL(jobHref, 'https://www.jobup.ch').toString() : null;

    await selectedJob.click();

    // A job jobup.ch's AI already analyzed before shows "Voir l'analyse" (read the existing
    // result) instead of "Voir mon match" (run a new analysis, then "Continuer" to confirm).
    // Confirmed live: for an already-analyzed job, no element on the page contains the text
    // "match" at all, so a plain role/name locator for "Voir mon match" times out — that's not a
    // broken selector, it's this other, already-analyzed state.
    const alreadyAnalyzedButton = page.getByRole('button', { name: /voir l'analyse/i });
    const newAnalysisButton = page.getByRole('button', { name: /voir mon match/i });

    const which = await Promise.race([
      alreadyAnalyzedButton.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'already'),
      newAnalysisButton.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'new'),
    ]).catch(() => null);

    let analysis;
    let meter;
    let criteria;
    if (which === 'already') {
      await alreadyAnalyzedButton.first().click();
      ({ analysis, meter, criteria } = await readAnalysisAndClose(page, 20000));
    } else if (which === 'new') {
      await newAnalysisButton.first().click();
      await page.getByRole('button', { name: 'Continuer', exact: true }).click();
      // The AI analysis can take a while to run; wait generously for "Fermer" to appear, since
      // that signals the result is ready to read (handled inside readAnalysisAndClose).
      ({ analysis, meter, criteria } = await readAnalysisAndClose(page, 60000));
    } else {
      const matchCandidates = await page.locator('[data-cy]').evaluateAll((els) => {
        const seen = new Set();
        for (const el of els) {
          const v = el.getAttribute('data-cy');
          if (v && /match|analys|cv/i.test(v)) seen.add(v);
        }
        return [...seen];
      });
      const buttonTexts = await page.getByRole('button').evaluateAll((els) =>
        els.slice(0, 30).map((el) => el.textContent?.trim().slice(0, 60))
      );
      console.error(
        '[jobup-cv-match] found neither "Voir l\'analyse" nor "Voir mon match". Current URL:',
        page.url(),
        'Candidate data-cy values:',
        JSON.stringify(matchCandidates),
        'Visible button texts:',
        JSON.stringify(buttonTexts)
      );
      throw new Error('Could not find either the "already analyzed" or "new analysis" button');
    }

    // A meter of either color (green or yellow) triggers saving/applying — only its *absence*
    // (the "Vos talents correspondent mieux à d'autres opportunités" heading, no meter rendered at
    // all) skips this outright; a yellow meter specifically is further gated by ignoreYellowMeter
    // inside prepareJobApplicationDraft(), and saveJob/easyApply gate the two actions independently.
    if (meter) {
      await prepareJobApplicationDraft(page, meter.color, { saveJob, easyApply, ignoreYellowMeter });
    } else {
      console.error(
        '[jobup-cv-match] no meter present (e.g. "Vos talents correspondent mieux à d\'autres ' +
          'opportunités"); not saving or applying.'
      );
    }

    return { success: true, analysis, meter, criteria, jobUrl, totalJobsCount, errorMessage: null, resultsUrl };
  } catch (err) {
    if (err instanceof EmptyResultsError) {
      const message =
        "0 job found, search term : '" + effectiveSearchTerm +
        "', locations : '" + effectiveLocations.join(', ') + "'";
      console.error('[jobup-cv-match]', message);
      return {
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount: 0,
        errorMessage: message,
        resultsUrl: page ? page.url() : null
      };
    }
    throw err;
  } finally {
    await browser.close();
  }
}

(async () => {
  const email = process.env.JOBUP_EMAIL;
  const password = process.env.JOBUP_PASSWORD;
  const jobIndex = process.argv[2] !== undefined ? Number(process.argv[2]) : 1;
  const useBasicSearch = process.argv[3] === 'true' || process.argv[3] === '1';
  const searchTerm = process.argv[4] || '';
  let locations = [];
  try {
    const parsedLocations = JSON.parse(process.argv[5] || '[]');
    locations = Array.isArray(parsedLocations) ? parsedLocations : [];
  } catch {
    locations = [];
  }
  const saveJob = process.argv[6] === 'true' || process.argv[6] === '1';
  const easyApply = process.argv[7] === 'true' || process.argv[7] === '1';
  const ignoreYellowMeter = process.argv[8] === 'true' || process.argv[8] === '1';

  if (!email || !password) {
    console.error('JOBUP_EMAIL and JOBUP_PASSWORD environment variables are required.');
    process.stdout.write(
      JSON.stringify({
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount: null,
        errorMessage: null,
        resultsUrl: null
      })
    );
    return;
  }

  try {
    const result = await runCvMatch(
      email,
      password,
      jobIndex,
      useBasicSearch,
      searchTerm,
      locations,
      saveJob,
      easyApply,
      ignoreYellowMeter
    );
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    console.error(err);
    process.stdout.write(
      JSON.stringify({
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        totalJobsCount: null,
        errorMessage: null,
        resultsUrl: null
      })
    );
  }
})();
