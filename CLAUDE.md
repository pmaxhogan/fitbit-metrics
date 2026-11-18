<!-- stack-template: claude-md/project-stub@2 e82426deb0ea -->

# fitbit-metrics

## Commands

- `npm test` - run the tests (vitest, Workers pool)
- `npm run check` - everything CI and the deploy gate run: typecheck, lint, format, ASCII, tests
- `npm run dev` - local dev server (wrangler)
- Deploy: push to `main` (Cloudflare Workers Builds runs `npm run build`, which runs the check first)

## Layout

- `src/index.ts` - Hono app: routes (`/authorize`, `/callback`, `/metrics`, `/purge`, docs)
- `src/health.ts` - Google Health API v4 client (KV-cached, retries) and the normalizers/fetchers
- `src/prom.ts` - Prometheus text formatter (`fitbit_*` metric names kept for old dashboards)
- `src/utils.ts`, `src/consts.ts` - date windows, concurrency pool, TTLs, KV key helpers
- `test/` - vitest specs run in the Workers pool
- See AGENTS.md for Cloudflare Workers notes

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: deps.dependabot-mechanism=workflow-run
- mode: test.coverage-ratchet=compare-job
- exception: auth.web - Not behind Cloudflare Access: /authorize and /callback are a public OAuth flow and Prometheus scrapes /metrics with a per-user bearer token, which Access would block. Reason: app-level bearer-token auth is the access control. (2026-11-18)

<!-- stack:end -->
