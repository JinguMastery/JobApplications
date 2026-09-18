# JobApplications

An Express backend paired with an Angular frontend (in `frontend/`, a separate git repository), including an automation feature that logs into [jobup.ch](https://www.jobup.ch) on demand.

## Prerequisites

- Node.js
- npm

## Setup

Install dependencies for both apps:

```bash
npm install
cd frontend && npm install
```

Install the Playwright browser used by the login automation and the e2e tests:

```bash
npx playwright install chromium
```

Set up credentials for the jobup.ch login automation:

```bash
cp .env.example .env
```

Then fill in `JOBUP_EMAIL` and `JOBUP_PASSWORD` in `.env` with real jobup.ch credentials. `.env` is gitignored — never commit it.

## Running

Start the backend and frontend in separate terminals:

```bash
npm start                    # Express API on http://localhost:3000
cd frontend && npm start     # Angular dev server on http://localhost:4200
```

Open `http://localhost:4200`. The page shows a live "Backend status" indicator and a "Login" button that triggers the jobup.ch login automation and displays "Login succeeded !" or "Login failed !".

## How it fits together

- The Express app (`app.js`, `routes/`, `bin/www`) exposes a small JSON API under `/api`.
- The Angular dev server proxies `/api/*` requests to the Express app (see `frontend/proxy.conf.json`).
- Clicking "Login" calls `POST /api/login`, which spawns `scripts/jobup-login.js` as a background process. That script drives a real (headless) browser via Playwright to log into jobup.ch with the credentials from `.env`, and reports success or failure back through the API.

See `CLAUDE.md` (this repo) and `frontend/CLAUDE.md` for more implementation detail, including how the jobup.ch automation's selectors were derived and its known limitations.

## Testing

```bash
npx playwright test          # root e2e suite (tests/)
cd frontend && npm test      # Angular unit tests
```

## Repository structure

This is two separate git repositories: the root of this repo (the Express backend, root-level Playwright tests, and the login automation script), and `frontend/` (the Angular app), which has its own `.git` and its own history.
