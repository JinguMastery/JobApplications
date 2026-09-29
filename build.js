#!/usr/bin/env node

/**
 * Bundles and minifies the Express backend for deployment to a remote server (the frontend
 * already has its own equivalent — `ng build` in frontend/, see frontend/CLAUDE.md — this only
 * covers the root app). Run via `npm run build`; produces a self-contained `dist/` folder:
 *
 * - `dist/bin/www.js` — the bundled server entry point, pulling in app.js and every routes/*.js
 *   file it requires (that whole require graph collapses into this one file).
 * - `dist/scripts/jobup-login.js` / `dist/scripts/jobup-cv-match.js` — bundled as their OWN
 *   separate entry points, deliberately NOT merged into the server bundle above: routes/api.js
 *   spawns each of these as an independent `node <scriptPath>` child process (see its own
 *   comment), not as a function call, so they need to keep existing as real, standalone,
 *   directly-executable files on disk at that same `scripts/<name>.js` path.
 * - `dist/views/`, `dist/public/` — copied as-is; these are read/served at runtime (Jade
 *   templates, static assets), not something a JS bundler processes.
 * - `dist/package.json` — pruned to just the production `dependencies` (no devDependencies) plus
 *   a `start` script pointing at the bundled entry point, for `npm ci --omit=dev` on the deploy
 *   target. `dist/package-lock.json` is copied alongside it if present, for a reproducible install.
 * - `dist/.env.example` — copied for reference; `.env` itself is never copied (it's gitignored
 *   and not read by this script either — create the real one directly in the deployed folder).
 *
 * Real npm dependencies (express, playwright, dotenv, ...) are deliberately left external —
 * `packages: 'external'` below — rather than inlined into the bundle: playwright in particular
 * ships native browser binaries a bundler can't meaningfully embed, and the root CLAUDE.md
 * already documents that a real `npm install`/`npm ci` is expected as part of deploying this app
 * (that's specifically why playwright is a direct production dependency, not just a transitive
 * devDependency of @playwright/test). So this step bundles and minifies this app's OWN first-party
 * code — fewer files, smaller footprint, no source structure exposed — while still relying on a
 * real `node_modules` (installed separately, on the target) for everything else.
 *
 * See app.js's and routes/api.js's own comments on `APP_ROOT`/`process.cwd()` for why those two
 * files (and scripts/jobup-login.js) resolve views/public/.env/scripts paths the way they do —
 * that choice is specifically what makes the bundled output below resolve those paths correctly
 * regardless of exactly how the entry files end up nested inside dist/.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

async function build() {
  fs.rmSync(DIST, { recursive: true, force: true });

  await esbuild.build({
    entryPoints: [
      path.join(ROOT, 'bin', 'www'),
      path.join(ROOT, 'scripts', 'jobup-login.js'),
      path.join(ROOT, 'scripts', 'jobup-search.js'),
      path.join(ROOT, 'scripts', 'jobup-cv-match.js')
    ],
    outdir: DIST,
    // Mirrors each entry point's own path relative to ROOT (rather than esbuild's default of the
    // lowest common ancestor across entry points) — so bin/www lands at dist/bin/www.js and each
    // script lands at dist/scripts/<name>.js, matching the source layout exactly and matching what
    // routes/api.js's `path.join(APP_ROOT, 'scripts', '<name>.js')` expects to find. scripts/
    // jobup-shared.js isn't listed as its own entry point — it's required by both jobup-search.js
    // and jobup-cv-match.js, so esbuild bundles its code straight into each of those two outputs
    // (the same way jobup-login.js's code already gets inlined into both), rather than needing a
    // separate dist/scripts/jobup-shared.js file that would just sit unused (nothing spawns it as
    // its own process).
    outbase: ROOT,
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    packages: 'external',
    logLevel: 'info'
  });

  copyDir(path.join(ROOT, 'views'), path.join(DIST, 'views'));
  copyDir(path.join(ROOT, 'public'), path.join(DIST, 'public'));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(DIST, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: pkg.private,
        scripts: { start: 'node bin/www.js' },
        dependencies: pkg.dependencies
      },
      null,
      2
    ) + '\n'
  );

  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    fs.copyFileSync(lockPath, path.join(DIST, 'package-lock.json'));
  }

  const envExamplePath = path.join(ROOT, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, path.join(DIST, '.env.example'));
  }

  console.log('\nBackend bundled to ' + DIST);
  console.log('Deploy: copy dist/ to the target server, run `npm ci --omit=dev` inside it, add a real .env, then `npm start`.');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
