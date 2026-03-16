# fitbit-metrics

Cloudflare Worker that exposes Fitbit health data as a Prometheus-compatible `/metrics` endpoint. Built with [Hono](https://hono.dev/).

## Metrics exposed

Sleep (hours, efficiency, stages), resting heart rate, HR zones, HRV (daily + deep RMSSD), skin temperature, SpO2, breathing rate, steps, calories, distance, floors.

## Routes

| Route | Description |
|---|---|
| `GET /metrics` | Prometheus scrape endpoint |
| `GET /authorize` | Starts Fitbit OAuth2 flow |
| `GET /callback` | OAuth2 callback |
| `GET /purge` | Clears the KV response cache |

All routes require a bearer token or `?token=` query param matching `METRICS_AUTH_TOKEN`.

## Setup

```sh
npm install
```

### Secrets / env vars

| Variable | Description |
|---|---|
| `FITBIT_CLIENT_ID` | Fitbit app client ID |
| `FITBIT_CLIENT_SECRET` | Fitbit app client secret |
| `METRICS_AUTH_TOKEN` | Bearer token for authenticating requests |

Set these as Wrangler secrets:

```sh
npx wrangler secret put FITBIT_CLIENT_ID
npx wrangler secret put FITBIT_CLIENT_SECRET
npx wrangler secret put METRICS_AUTH_TOKEN
```

### KV namespace

The worker uses a KV namespace (`FITBIT_KV`) to store the rotating refresh token and cache API responses (12h TTL). The binding is already configured in `wrangler.jsonc`.

## Dev

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

## Notes

- Fetches the last 30 days of data per scrape
- Caches Fitbit API responses in KV to stay within rate limits
- Limits outbound fetch concurrency to 6 (Workers connection limit)
- Retries on 429s with backoff using the `Fitbit-Rate-Limit-Reset` header
