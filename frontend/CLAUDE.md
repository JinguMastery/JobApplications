# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This started as a freshly scaffolded Angular application (`ng new`, Angular CLI 21.2.24) with SSR enabled. `src/app/app.routes.ts` still has no routes defined, but the root `App` component now calls the backend (see below) as a working example of the frontend/backend connection. Architecture notes below describe the scaffold's structure so future work can build on it consistently; update this file as real features are added.

## Connection to the backend

This app is paired with a separate Express API at the repository root (`../app.js`, `../routes/api.js`) — see the root `CLAUDE.md` for the full picture. On this side:

- `provideHttpClient(withFetch())` is registered in `src/app/app.config.ts`.
- `src/app/services/api.ts` (`Api` service) wraps calls to the backend, e.g. `getHealth()` → `GET /api/health`.
- `proxy.conf.json` (repo root of `frontend/`) proxies `/api/*` to `http://localhost:3000` during `ng serve` — wired up via `serve.options.proxyConfig` in `angular.json`. This means components/services should call relative paths like `/api/health`, not `http://localhost:3000/api/health`.
- Run the root Express app (`npm start` from the repository root) alongside `ng serve` here to exercise the connection locally.
- The "Login" button in `app.html` calls `Api.login()` → `POST /api/login`, which runs a real jobup.ch login automation on the backend and returns a display message ("Login succeeded !" / "Login failed !"). See the root `CLAUDE.md`'s "jobup.ch login automation" section for how that works and its limitations.

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
