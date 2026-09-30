# JobApplications

A local tool for automating job hunting on [jobup.ch](https://www.jobup.ch) — or [jobs.ch](https://www.jobs.ch), its sister site, via a toggle. An Angular frontend sends requests to an Express backend. The backend runs Playwright scripts that drive a real (headless) browser to:

- **Log in** with your jobup.ch or jobs.ch account.
- **Run a CV match** over a range of job indexes, in parallel: search for jobs, pick each one, and read the site's AI analysis of how well your CV matches it (overall meter plus a per-criterion checklist) — for every index in the range at once.
- **Draft an application** (optional, per job): when a match is good enough, save the job and/or prepare an "easy apply" application as a **draft**. The script never submits it.

> ⚠️ This drives jobup.ch/jobs.ch's live websites. Any change to their markup can break the automation, and too many automated logins/analyses in a short window may trigger rate limits or a CAPTCHA. Selectors, confirmed-live gotchas, and jobs.ch's (much lighter) verification status are documented in [CLAUDE.md](CLAUDE.md).

## Prerequisites

- Node.js and npm
- A jobup.ch and/or jobs.ch account (with a CV uploaded to your profile, for the CV match)

## Setup

1. Install dependencies for both apps:

   ```bash
   npm install
   cd frontend && npm install
   ```

2. Install the Chromium browser that Playwright uses:

   ```bash
   npx playwright install chromium
   ```

3. Create your `.env` from the template and fill in credentials for whichever site(s) you use:

   ```bash
   cp .env.example .env
   ```

   | Variable          | Required | Description                                                                 |
   | ----------------- | -------- | --------------------------------------------------------------------------- |
   | `JOBUP_EMAIL`     | yes\*    | jobup.ch login email                                                        |
   | `JOBUP_PASSWORD`  | yes\*    | jobup.ch password                                                           |
   | `JOBSCH_EMAIL`    | yes\*    | jobs.ch login email                                                         |
   | `JOBSCH_PASSWORD` | yes\*    | jobs.ch password                                                            |
   | `BACKEND_URL`     | no       | Where the CV-match worker posts its results (default `http://localhost:3000`) |

   \* Only the pair for the site(s) you actually use is required — fill in either or both. Which pair a given Login/CV Analysis attempt uses is picked by that action's own "Use www.jobs.ch" checkbox (see below). A successful login rewrites the matching pair in `.env` automatically, so you can also just leave both blank and log in through the UI once.

   `.env` is gitignored. Never commit it.

## Running

Start the backend and frontend in two terminals:

```bash
npm start                    # Express API on http://localhost:3000
cd frontend && npm start     # Angular dev server on http://localhost:4200
```

Then open <http://localhost:4200>. The page shows a **Backend status** indicator, which should read "connected".

## Using the app

### Login

Fill in Email/Password, optionally check **Use www.jobs.ch** to log into jobs.ch instead of jobup.ch, then click **Login**. You'll see "Login succeeded !" or "Login failed !" (or a specific reason, e.g. invalid credentials). A successful login is written back to `.env`, so the next CV Analysis run for that same site picks it up automatically — no restart needed.

### CV Analysis

Fill in the inputs, then click **CV Analysis**. It analyzes every job index from **Start** to **End**, in parallel batches of 5, after logging in and searching once. A run's duration scales with the size of the range — a single job usually takes under a minute; a wide range takes several minutes.

| Input               | Meaning                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Search term**      | Keyword to search for. Left empty, it defaults to `Développeur`. It's ignored when "Search with my profile" is available, because that feature generates its own term from your profile. |
| **Locations**        | Comma-separated list of cities or regions (e.g. `Genève, Lausanne`). Defaults to `Genève`.                        |
| **Start job index**  | First result to analyze, 1-based and counted across all result pages (e.g. `25` is the 5th job on page 2).    |
| **End job index**    | Last result to analyze (inclusive). Set equal to Start to analyze just one job. An End beyond the real number of results is silently clamped — only an out-of-range **Start** fails the whole request. |

The **Job filters** dropdown controls the site, search mode, and what happens after each analysis:

| Option                   | Effect                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Use www.jobs.ch**       | Searches and analyzes jobs.ch instead of jobup.ch for this run. Independent of the Login button's own copy of this toggle. |
| **Use basic search**      | Uses the site's classic filter search instead of "Search with my profile". Needed if you want reliable location filtering. |
| **Save job**              | Bookmarks the job when the match meter qualifies.                                               |
| **Easy apply**            | Opens the job's "Candidature simplifiée" (if it has one) and prepares a draft application.                  |
| **Ignore jobs with a yellow meter** | Only green (strong) matches qualify for save/apply. Otherwise green and yellow both qualify.                 |

The result shows the total number of matching jobs and a link to the results page, then one block per job index actually analyzed — a link to the job, a link to the draft application if one was opened, and either the expandable AI analysis (each criterion marked met/partially met/not met) or that job's own failure reason. A **Stop analysis** button cancels an in-progress run; already-completed jobs still show their results.

### What "Easy apply" fills in

On the application page, the script:

- generates a cover letter with the site's "Générer" button, only if that field is required and empty;
- attaches the documents listed in `REQUIRED_DOCUMENT_NAMES` ([scripts/jobup-cv-match.js](scripts/jobup-cv-match.js)) from your profile, skipping any that are already attached. **Edit this list to match the file names in your own profile.**
- answers **"Oui"** to every yes/no question. Review these answers before you submit, because "Non" may be the honest answer to some questions.
- clicks **Sauvegarder** to save the draft.

Then open the site yourself, review the draft and submit it.

## How it fits together

```
Angular (4200) ──/api proxy──▶ Express (3000)
                                     │
                                     ├─ POST /api/login ──spawns──▶ scripts/jobup-login.js ──Playwright──▶ jobup.ch/jobs.ch
                                     │
                                     └─ POST /api/cv-match
                                          │ spawns once
                                          ▼
                                     scripts/jobup-search.js ───Playwright──▶ jobup.ch/jobs.ch (login + search)
                                          │ saves session (storageState), then spawns per job index, in batches of 5
                                          ▼
                                     scripts/jobup-cv-match.js × N ──Playwright──▶ jobup.ch/jobs.ch (pick job, read analysis)
                                          │
                                          └──── POST /api/cv-analysis (logged by the backend) ────┘
```

`scripts/jobup-search.js` logs in and runs the search exactly once per request, then hands its authenticated session to however many `scripts/jobup-cv-match.js` workers are needed (one per job index in the Start–End range) — see [CLAUDE.md](CLAUDE.md)'s "jobup.ch CV-match automation" section for the full split. Both scripts share small helpers from `scripts/jobup-shared.js`.

| Endpoint                 | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health`         | Backend health check                                                         |
| `POST /api/login`         | Runs [scripts/jobup-login.js](scripts/jobup-login.js)                        |
| `POST /api/cv-match`      | Runs [scripts/jobup-search.js](scripts/jobup-search.js) once, then [scripts/jobup-cv-match.js](scripts/jobup-cv-match.js) once per job index in the requested range |
| `POST /api/cv-match/stop` | Kills the currently-running search/worker processes for the in-flight `/cv-match` request |
| `POST /api/cv-analysis`   | Receives one job's analysis from a worker. It only logs it for now (no persistence) |

Each script runs as a child process and prints one line of JSON to stdout, which the API relays to the frontend. You can also run the scripts directly for debugging:

```bash
JOBUP_EMAIL=... JOBUP_PASSWORD=... node scripts/jobup-login.js
JOBSCH_EMAIL=... JOBSCH_PASSWORD=... node scripts/jobup-login.js true   # jobs.ch instead
```

## Testing

```bash
npx playwright test          # root e2e suite (tests/)
npx playwright show-report   # view the last report
cd frontend && npm test      # Angular unit tests (Vitest)
```

## Backend build/deployment

`npm run build` bundles and minifies the root Express app (with esbuild) into a self-contained `dist/` folder — see [build.js](build.js)'s own header comment for exactly what it produces. To deploy: copy `dist/` to the target server, run `npm ci --omit=dev` inside it, add a real `.env`, then `npm start`. This only covers the backend; the frontend has its own build (`cd frontend && ng build`, see `frontend/CLAUDE.md`), and nothing yet decides whether Express serves the built Angular app, proxies to it, or the two are deployed as fully separate services.

## Project structure

```
app.js, bin/, routes/   Express backend (routes/api.js is the real API)
scripts/                Playwright automations (login, search, CV match + application drafting)
build.js                Bundles the backend for deployment (npm run build)
tests/                  Playwright e2e tests
frontend/               Angular 21 SSR app (see frontend/CLAUDE.md)
CLAUDE.md               Detailed implementation notes and selector pitfalls (jobup.ch and jobs.ch)
```

## Limitations

- Local development only, beyond the backend's own bundling story (see "Backend build/deployment" above) — there's no combined frontend+backend production deployment yet.
- jobs.ch support is confirmed for the core flow — login, search, parallel job selection, and analysis (including a weak-match/no-meter result) have all worked correctly in real runs — but some parts (location filtering beyond a single value, pagination past page 1, the application-drafting flow) haven't specifically been exercised there yet, only on jobup.ch. Expect rough edges there and check the backend logs if something looks wrong.
- On the "Search with my profile" path, location filtering isn't applied. Check **Use basic search** when you need results filtered by location.
- The application-drafting flow hasn't been fully verified against the live site. Check drafts before submitting them.
- A job's AI analysis can occasionally take longer than expected to generate when several are running in parallel; a timed-out job reports its own error rather than failing the whole run, and can simply be re-run.
