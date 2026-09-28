# JobApplications

A local tool for automating job hunting on [jobup.ch](https://www.jobup.ch). An Angular frontend sends requests to an Express backend. The backend runs Playwright scripts that drive a real (headless) browser against jobup.ch to:

- **Log in** with your jobup.ch account.
- **Run a CV match**: search for jobs, pick one, and read jobup.ch's AI analysis of how well your CV matches it (overall meter plus a per-criterion checklist).
- **Draft an application** (optional): when the match is good enough, save the job and/or prepare an "easy apply" application as a **draft**. The script never submits it.

> ⚠️ This drives jobup.ch's live website. Any change to its markup can break the automation, and too many automated logins in a short window may trigger rate limits or a CAPTCHA. Selectors and known pitfalls are documented in [CLAUDE.md](CLAUDE.md).

## Prerequisites

- Node.js and npm
- A jobup.ch account (with a CV uploaded to your profile, for the CV match)

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

3. Create your `.env` from the template and fill in your jobup.ch credentials:

   ```bash
   cp .env.example .env
   ```

   | Variable         | Required | Description                                                                 |
   | ---------------- | -------- | --------------------------------------------------------------------------- |
   | `JOBUP_EMAIL`    | yes      | jobup.ch login email                                                        |
   | `JOBUP_PASSWORD` | yes      | jobup.ch password                                                           |
   | `BACKEND_URL`    | no       | Where the CV-match script posts its results (default `http://localhost:3000`) |

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

Click **Login** to check that your credentials work. You'll see "Login succeeded !" or "Login failed !".

### CV Analysis

Fill in the inputs, then click **CV Analysis**. A run usually takes 15–80 seconds.

| Input           | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| **Search term** | Keyword to search for. Left empty, it defaults to `Développeur`. It's ignored when jobup.ch's "Search with my profile" is available, because that feature generates its own term from your profile. |
| **Locations**   | Comma-separated list of cities or regions (e.g. `Genève, Lausanne`). Defaults to `Genève`.                        |
| **Job index**   | Which result to analyze, 1-based and counted across all result pages (e.g. `25` is the 5th job on page 2).     |

The **Job filters** dropdown controls the search mode and what happens after the analysis:

| Option                  | Effect                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Use basic search**    | Uses jobup.ch's classic filter search instead of "Search with my profile". Needed if you want reliable location filtering. |
| **Save job**            | Bookmarks the job on jobup.ch when the match meter qualifies.                                               |
| **Easy apply**          | Opens the job's "Candidature simplifiée" (if it has one) and prepares a draft application.                  |
| **Ignore yellow meter** | Only green (strong) matches qualify for save/apply. Otherwise green and yellow both qualify.                 |

The result shows the total number of matching jobs, a link to the results page, a link to the selected job, and the expandable AI analysis with each criterion marked as met, partially met or not met.

### What "Easy apply" fills in

On the application page, the script:

- generates a cover letter with jobup.ch's "Générer" button, only if that field is required and empty;
- attaches the documents listed in `REQUIRED_DOCUMENT_NAMES` ([scripts/jobup-cv-match.js](scripts/jobup-cv-match.js)) from your jobup.ch profile, skipping any that are already attached. **Edit this list to match the file names in your own profile.**
- answers **"Oui"** to every yes/no question. Review these answers before you submit, because "Non" may be the honest answer to some questions.
- clicks **Sauvegarder** to save the draft.

Then open jobup.ch yourself, review the draft and submit it.

## How it fits together

```
Angular (4200) ──/api proxy──▶ Express (3000) ──spawns──▶ scripts/jobup-*.js ──Playwright──▶ jobup.ch
                                     ▲                               │
                                     └──── POST /api/cv-analysis ────┘
```

| Endpoint                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health`       | Backend health check                                                         |
| `POST /api/login`       | Runs [scripts/jobup-login.js](scripts/jobup-login.js)                        |
| `POST /api/cv-match`    | Runs [scripts/jobup-cv-match.js](scripts/jobup-cv-match.js) with the search options above |
| `POST /api/cv-analysis` | Receives the analysis from the script. It only logs it for now (no persistence) |

Each script runs as a child process and prints one line of JSON to stdout, which the API relays to the frontend. You can also run the scripts directly for debugging:

```bash
JOBUP_EMAIL=... JOBUP_PASSWORD=... node scripts/jobup-login.js
```

## Testing

```bash
npx playwright test          # root e2e suite (tests/)
npx playwright show-report   # view the last report
cd frontend && npm test      # Angular unit tests (Vitest)
```

## Project structure

```
app.js, bin/, routes/   Express backend (routes/api.js is the real API)
scripts/                Playwright automations (login, CV match + application drafting)
tests/                  Playwright e2e tests
frontend/               Angular 21 SSR app (see frontend/CLAUDE.md)
CLAUDE.md               Detailed implementation notes and jobup.ch selector pitfalls
```

## Limitations

- Local development only. There is no production deployment setup yet.
- On the "Search with my profile" path, location filtering isn't applied. Check **Use basic search** when you need results filtered by location.
- The application-drafting flow hasn't been fully verified against the live site. Check drafts before submitting them.
