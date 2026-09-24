# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This started as a freshly scaffolded Angular application (`ng new`, Angular CLI 21.2.24) with SSR enabled. `src/app/app.routes.ts` still has no routes defined, but the root `App` component now calls the backend (see below) as a working example of the frontend/backend connection. Architecture notes below describe the scaffold's structure so future work can build on it consistently; update this file as real features are added.

## Connection to the backend

This app is paired with a separate Express API at the repository root (`../app.js`, `../routes/api.js`) — see the root `CLAUDE.md` for the full picture. On this side:

- `provideHttpClient(withFetch())` and `provideZonelessChangeDetection()` are registered in `src/app/app.config.ts` — this app has no zone.js dependency, so it relies entirely on Angular signals for change detection; the explicit provider is required for that to be reliable rather than implicit.
- `src/app/services/api.ts` (`Api` service) wraps calls to the backend, e.g. `getHealth()` → `GET /api/health`.
- `proxy.conf.json` (repo root of `frontend/`) proxies `/api/*` to `http://localhost:3000` during `ng serve` — wired up via `serve.options.proxyConfig` in `angular.json`. This means components/services should call relative paths like `/api/health`, not `http://localhost:3000/api/health`.
- Run the root Express app (`npm start` from the repository root) alongside `ng serve` here to exercise the connection locally.
- The "Login" button in `app.html` calls `Api.login()` → `POST /api/login`, which runs a real jobup.ch login automation on the backend and returns `{ success, message }` ("Login succeeded !" / "Login failed !"). See the root `CLAUDE.md`'s "jobup.ch login automation" section for how that works and its limitations.
- The "CV Analysis" button in `app.html` calls `Api.cvMatch(jobIndex, useBasicSearch, searchTerm, locations)` → `POST /api/cv-match` with `{ jobIndex, useBasicSearch, searchTerm, locations }`, which runs the jobup.ch job-search + AI CV-match automation on the backend and returns `{ success, analysis, meter, criteria, jobUrl, totalJobsCount, errorMessage, resultsUrl }`. The frontend (not the backend) picks the displayed message on failure: `errorMessage` as-is when non-null (a specific, expected failure — e.g. jobup.ch reporting 0 matching jobs for the given search term/locations, or an invalid/out-of-range `jobIndex`), else the generic "Analysis failed !"; on success it's always "Analysis succeeded !". `totalJobsCount` (as a "Number of jobs :" span) and `resultsUrl` (as a "Link to the job results page :" span right after it, on the same row with `padding-left` between them — both inside one `<p class="cv-match-total-jobs">`, between the result message and "Link to the job :") are each shown whenever non-null *regardless* of `success` — they're still useful context (e.g. explaining why a high `jobIndex` came back out of range, confirming a 0-match search, or letting the user open the actual results page jobup.ch searched) even when the specific requested job wasn't found. See the root `CLAUDE.md`'s "jobup.ch CV-match automation" section for how that works and its selectors.
- `jobIndex` is a 1-based signal (default `1`) driven by the "Job index :" number input next to the CV Analysis button (`onJobIndexInput` in `app.ts`); it selects which job to analyze, counting across all of the automation's search-result pages (the script paginates to find it — see the root `CLAUDE.md`). A non-positive index, or one beyond the number of jobs actually found on its target page, returns `success: false` with a specific `errorMessage` ("Job index must be a positive integer" / "Job index must not be greater than the number of jobs found on that page") shown in place of the generic "Analysis failed !" — and `totalJobsCount` from the search that was actually run, not `null`, since the search still completed even though the requested index didn't resolve to a job.
- `searchTerm` and `locationInput` are string signals (both default `''`) driven by the "Search term :" and "Location :" text inputs next to "Job index :" (`onSearchTermInput`/`onLocationInput` in `app.ts`, both `maxlength="255"`, sized narrow so the whole `.cv-match-section` row still fits on one line). On submit, `onCvMatchClick()` trims `searchTerm`, and splits `locationInput` on commas, trims each part, and drops empty ones, before sending `searchTerm: string` and `locations: string[]` to the backend. `routes/api.js` trims/truncates (255 chars) and re-filters these again server-side, then forwards them to `scripts/jobup-cv-match.js` as extra CLI args; the script falls back to its own `RECOVERY_SEARCH_TERM`/`LOCATION_SLUG` constants for whichever comes out empty, and — since "Rechercher avec mon profil" generates its own profile-derived term server-side — ignores `searchTerm` (and its fallback) entirely on any path where that CTA is actually used. Each location becomes its own repeated `location=` query param (not one comma-joined value) wherever the script applies a location filter. See the root `CLAUDE.md`'s "jobup.ch CV-match automation" section for the details and the known CTA-path location-filtering limitation this doesn't change.
- `useBasicSearch` is a boolean signal (default `false`) driven by the "Use basic search" checkbox next to the CV Analysis button (`onUseBasicSearchChange` in `app.ts`). Unchecked (default): the backend tries the profile-based "Rechercher avec mon profil" CTA first and only falls back to the basic-search entry point if it's unavailable (existing behavior). Checked: it skips the CTA and goes straight to the basic-search entry point — mainly useful for exercising/testing that path directly without depending on jobup.ch account state.
- `backendStatus` (the "Backend status: …" badge) is set both by the initial `getHealth()` check on load *and* by the `success` booleans returned from the Login/CV Analysis calls, even though those two actions don't call `/api/health` themselves. The two actions are tracked separately (`lastLoginSuccess`/`lastCvMatchSuccess` in `app.ts`) and combined via `updateBackendStatusFromActions()`: either one succeeding sets `'connected'`; it only drops to `'unreachable'` once *both* have been tried and *both* failed — a single failed login (e.g. wrong jobup.ch credentials) doesn't by itself mean the backend is unreachable.

**Important**: `src/app/app.routes.server.ts` sets `RenderMode.Prerender` for all routes, so `ng build` renders the app once at *build time*, with no backend available. Any HTTP call made unconditionally in a component constructor (like the original health check) breaks that build. Guard such calls with `afterNextRender(() => { ... })` (see `app.ts`) so they only run in the browser, after hydration — never call `HttpClient` directly in a constructor on a prerendered route.

## Commands

Run all commands from the `frontend/` directory.

- `npm start` / `ng serve` — start the dev server at `http://localhost:4200/` with live reload.
- `ng build` — production build, output to `dist/`.
- `ng build --configuration development` — dev build (no optimization, source maps on).
- `npm test` / `ng test` — run unit tests via Vitest.
- `ng generate component <name>` — scaffold a new component (also `ng generate directive|pipe|service`, etc.); run `ng generate --help` for the full list.
- `node dist/frontend/server/server.mjs` — run the built SSR server (after `ng build`).

There is no e2e test runner configured, and no linter (e.g. ESLint) is set up yet.

## Architecture

- **Stack**: Angular 21 (standalone components, no NgModules), TypeScript 5.9 in strict mode, RxJS, Vitest for unit tests.
- **SSR**: The app is configured for server-side rendering via `@angular/ssr`.
  - `src/main.ts` — browser entry point.
  - `src/main.server.ts` — server entry point.
  - `src/server.ts` — Express server used to serve the SSR app.
  - `src/app/app.config.ts` — client-side app config (providers).
  - `src/app/app.config.server.ts` — server-side app config, merged with the client config for SSR.
  - `src/app/app.routes.server.ts` — server-only route rendering configuration (e.g. prerendering mode per route), separate from `src/app/app.routes.ts`.
  - The build's `outputMode` is `server` (see `angular.json`), meaning `ng build` produces both browser and server bundles under `dist/frontend/`.
- **Routing**: Client routes live in `src/app/app.routes.ts` (currently empty). Server-specific rendering behavior per route goes in `src/app/app.routes.server.ts`.
- **Components**: Standalone Angular components — no `@NgModule` declarations. Follow the existing `App` component's pattern (`app.ts` + `app.html` + `app.css`, using `imports: [...]` on the `@Component` decorator).
- **Testing**: Unit tests run through Angular's built-in Vitest builder (`@angular/build:unit-test`), not a standalone Vitest config. Test files are colocated with source as `*.spec.ts` (see `src/app/app.spec.ts`).

## Code style

- Single quotes, 100-character print width, 2-space indentation (see `.prettierrc`, `.editorconfig`).
- HTML files are formatted with Prettier's Angular parser.
- TypeScript strict mode is fully enabled, including `strictTemplates`, `strictInjectionParameters`, and `strictInputAccessModifiers` — write components and templates accordingly (explicit input access modifiers, no implicit `any`, etc.).
