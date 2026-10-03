# pi-playwright-extension

## 0.1.8 — 2026-10-03

- Declare host-provided TypeBox and the Pi API as wildcard peer dependencies, not runtime dependencies.
- Keep exact development dependencies for reproducible API checks and tests.
- Add manifest/resource-loader regression coverage for Pi 1's host-package warnings.

## 0.1.7 — 2026-10-03

- Remove the handwritten Pi declaration shim; typecheck against real Pi 1.0.0 declarations.
- Pin development tooling and update the dependency lockfile.
- Retain browser tools, diagnostics, video recording and lazy startup.

Verification: `npm run check`, `npm test` (6 tests, including real headless browser fixture navigation); real Pi 1.0 extension-loader smoke check. No authenticated website mutation was tested.

## 0.1.6

### Patch Changes

- Lazy-load the Playwright browser runtime so Pi startup registers tools and flags without importing Playwright until a browser tool or command starts a browser session.

## 0.1.5

### Patch Changes

- Update Pi extension type imports to the current `@earendil-works/pi-coding-agent` package namespace for compatibility with recent Pi releases.
