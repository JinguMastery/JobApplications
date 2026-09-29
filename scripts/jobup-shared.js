/**
 * Small helpers shared between scripts/jobup-search.js (the one-time login+search step) and
 * scripts/jobup-cv-match.js (the per-job-index worker, now run once per job in parallel — see
 * CLAUDE.md's "jobup.ch CV-match automation" section for why the split exists and how the two
 * scripts hand off via a saved Playwright `storageState` file). Pulled out into their own module
 * so both scripts stay in sync on things like the page-size constant, rather than risking drift
 * from two independently-edited copies.
 */

const JOBS_PER_PAGE = 20;

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
// term/location combination — distinct from every other failure (a real selector break, a
// network hiccup, etc.), which stay as plain Errors/TimeoutErrors. Callers' own catch for this
// type turns it into an explicit, immediate success:false response instead of running the 20s
// locator wait all the way out to a generic Playwright TimeoutError.
class EmptyResultsError extends Error {
  constructor(pageLabel) {
    super('jobup.ch reported 0 matching jobs on page ' + pageLabel);
    this.name = 'EmptyResultsError';
  }
}

// Waits for at least one job result to render on the current page. Confirmed live: a search with
// 0 matches (e.g. term/location combination too narrow) renders a `[data-cy="empty-result"]`
// element instead of any job-link/article element — without racing against it too, an earlier
// version of this just sat out the full 20s locator timeout and surfaced a generic, unhelpful
// Playwright TimeoutError for what is actually a normal, expected outcome. Dumps diagnostics and
// rethrows only if genuinely neither state appears (a real break, not 0 results).
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
    'could not find a job result on page ' + pageLabel + '. Current URL:',
    page.url(),
    'Candidate job links:',
    JSON.stringify(jobHrefs),
    'Candidate data-cy values:',
    JSON.stringify(dataCyCandidates)
  );
  throw new Error('Timed out waiting for job results on page ' + pageLabel);
}

module.exports = { JOBS_PER_PAGE, dedupeByHref, EmptyResultsError, waitForJobResults };
