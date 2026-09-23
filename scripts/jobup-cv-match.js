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
 * scripts/jobup-cv-match.js [jobIndex] [useBasicSearch]`) and inspect
 * `page.locator('body').ariaSnapshot()`.
 *
 * Reads credentials from JOBUP_EMAIL / JOBUP_PASSWORD, the 1-based job index to select from
 * `process.argv[2]` (defaults to 1, the first job), and whether to skip straight to the
 * "Recherche d'emploi" sub-nav tab / basic-search entry point instead of the profile-based CTA
 * from `process.argv[3]` (`'true'`/`'1'`; defaults to false, i.e. try the CTA first as usual and
 * only fall back to basic search if it's unavailable). jobup.ch paginates results at JOBS_PER_PAGE
 * (20) per page, so an index beyond the first page clicks a "next page" control that many times
 * (deep-linking via a `?page=N` query param doesn't work — see CLAUDE.md) and selects position
 * `((jobIndex - 1) % 20) + 1` on the page it lands on. If the index is not a positive integer or
 * exceeds the number of jobs actually found on its target page, returns success: false without
 * attempting an analysis. Once the analysis text is available, POSTs it as { analysis } to
 * `${BACKEND_URL}/api/cv-analysis` (BACKEND_URL defaults to http://localhost:3000) before
 * dismissing the result dialog. Prints a single JSON line to stdout:
 * {"success": true|false, "analysis": string|null, "jobUrl": string|null,
 * "totalJobsCount": number|null}. `jobUrl` is the selected job's own detail-page URL
 * (https://www.jobup.ch/fr/emplois/detail/...), read from the job link's `href` before clicking
 * it — jobup.ch renders the job detail in place rather than navigating there, so the browser's own
 * URL after the click is still the search results page, not the job. `totalJobsCount` is the
 * total-match count read from the "... offres d'emploi" text near the top of the results page.
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
const RECOVERY_SEARCH_TERM = 'développeur';

// The location applied via the `location=<slug>` query param (see the comment where it's used,
// below) — confirmed live as a real, working slug: `location=genève` returns genuinely
// Genève-filtered results (e.g. "10 Offres d'emploi Développeur à Genève").
const LOCATION_SLUG = 'Genève';

async function sendAnalysisToBackend(analysis) {
  const response = await fetch(BACKEND_URL + '/api/cv-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis }),
  });

  if (!response.ok) {
    throw new Error('Backend responded with ' + response.status + ' while posting CV analysis');
  }
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

// Waits for at least one job result to render on the current page, or dumps diagnostics and
// rethrows if none appear. Shared between the initial page-1 wait and, if jobIndex requires
// pagination, the wait after navigating to the target page.
async function waitForJobResults(page, anyJobResult, pageLabel) {
  try {
    await anyJobResult.first().waitFor({ state: 'visible', timeout: 20000 });
  } catch (waitErr) {
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
    throw waitErr;
  }
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

  await sendAnalysisToBackend(analysis);

  await closeButton.click();

  return analysis;
}

async function runCvMatch(email, password, jobIndex, useBasicSearch) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('https://www.jobup.ch/fr/');

    await dismissCookieConsent(page);

    const loggedIn = await performLogin(page, email, password);
    if (!loggedIn) {
      return { success: false, analysis: null, jobUrl: null, totalJobsCount: null };
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
            'URL with RECOVERY_SEARCH_TERM and LOCATION_SLUG instead of filling fields through the UI.'
        );
        const recoveryUrl = new URL(page.url());
        recoveryUrl.searchParams.set('term', RECOVERY_SEARCH_TERM);
        recoveryUrl.searchParams.set('location', LOCATION_SLUG);
        await page.goto(recoveryUrl.toString());
        await waitForJobResults(page, anyJobResult, '1 (recovery term+location via URL)');
        skipSearchSubmit = true;
      }
    }

    // On the basic-search recovery UI, fill in RECOVERY_SEARCH_TERM so the search isn't
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
        await termField.first().fill(RECOVERY_SEARCH_TERM);
        // Filling a typeahead field like this one opens its own suggestions dropdown; Escape
        // dismisses it without picking a suggestion, keeping the typed term.
        await termField.first().press('Escape');
        console.error('[jobup-cv-match] filled the basic-search term field with "' + RECOVERY_SEARCH_TERM + '".');
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

    if (!Number.isInteger(jobIndex) || jobIndex < 1) {
      console.error('[jobup-cv-match] jobIndex ' + jobIndex + ' must be a positive integer.');
      return { success: false, analysis: null, jobUrl: null, totalJobsCount: null };
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
        locationUrl.searchParams.set('location', LOCATION_SLUG);
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
      return { success: false, analysis: null, jobUrl: null, totalJobsCount };
    }

    const selectedJob = orderedJobs[inPageIndex - 1];

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
    if (which === 'already') {
      await alreadyAnalyzedButton.first().click();
      analysis = await readAnalysisAndClose(page, 20000);
    } else if (which === 'new') {
      await newAnalysisButton.first().click();
      await page.getByRole('button', { name: 'Continuer', exact: true }).click();
      // The AI analysis can take a while to run; wait generously for "Fermer" to appear, since
      // that signals the result is ready to read (handled inside readAnalysisAndClose).
      analysis = await readAnalysisAndClose(page, 60000);
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

    return { success: true, analysis, jobUrl, totalJobsCount };
  } finally {
    await browser.close();
  }
}

(async () => {
  const email = process.env.JOBUP_EMAIL;
  const password = process.env.JOBUP_PASSWORD;
  const jobIndex = process.argv[2] !== undefined ? Number(process.argv[2]) : 1;
  const useBasicSearch = process.argv[3] === 'true' || process.argv[3] === '1';

  if (!email || !password) {
    console.error('JOBUP_EMAIL and JOBUP_PASSWORD environment variables are required.');
    process.stdout.write(JSON.stringify({ success: false, analysis: null, jobUrl: null, totalJobsCount: null }));
    return;
  }

  try {
    const result = await runCvMatch(email, password, jobIndex, useBasicSearch);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    console.error(err);
    process.stdout.write(JSON.stringify({ success: false, analysis: null, jobUrl: null, totalJobsCount: null }));
  }
})();
