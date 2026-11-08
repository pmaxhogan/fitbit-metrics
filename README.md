# [fitbit-metrics`.maxhogan.dev`](https://github.com/pmaxhogan/fitbit-metrics)

Convert Fitbit health data into Prometheus metrics.

Cloudflare Worker that exposes Fitbit health data as a Prometheus-compatible `/metrics` endpoint. Includes sleep, RHR, HR zone, HRV, skin temp, SpO2, calories, steps, distance, & floors. Built with [Hono](https://hono.dev/) + TS.

Data comes from the [Google Health API](https://developers.google.com/health) (v4), the successor to the Fitbit Web API, which Google decommissioned on 2026-10-30. Metric names keep their `fitbit_` prefix so existing dashboards keep working.

## Requirements

1. Prometheus
2. A Fitbit (or Pixel Watch) account migrated to a Google account, signed in to the Google Health app

## Steps

1. [Authorize](/authorize) this app with your Google account
2. Save the API token returned from step 1
3. Configure your Prometheus server to scrape `/metrics` using your saved API token (using `Authorization: Bearer abcd1234-...` header or `?token=abcd1234-...`)

```yaml
- job_name: fitbit
  scrape_interval: 15m
  scheme: https
  authorization:
    type: Bearer
    credentials: "abcd1234-..."
  static_configs:
    - targets: ["fitbit-metrics.maxhogan.dev"]
```

Metrics are cached for 12 hours on the server-side, so `scrape_interval` can be pretty aggressive if you want but updated data may be delayed.

### Re-linking an existing token

Visit `/authorize?token=<your API token>` to re-authorize without changing the token, e.g. after Google revokes access. The token in your Prometheus config keeps working.

### Historical backfill (`?daysAgo=`)

`/metrics` returns the most recent 30 days by default. Pass `?daysAgo=N` to shift the 30-day window `N` days further into the past - e.g. `?daysAgo=30` returns the 30 days before the default window, `?daysAgo=60` the 30 before that, and so on. This lets you backfill older history one window at a time. `daysAgo` defaults to `0` (the current behavior) and must be a non-negative integer. Historical windows (`daysAgo>0`) are immutable, so they're cached longer (7 days) than the current window.

## Links

- [Authorize with Google](/authorize)
- [API Reference](/reference) ([OpenAPI](/doc))
- [Privacy policy](/privacy)
- [GitHub](https://github.com/pmaxhogan/fitbit-metrics)
- [My Website](https://maxhogan.dev)

## Metrics

All metrics are Prometheus gauges, labeled by `date` (and additional labels where noted). Data covers the last 30 days per scrape.

| Metric                              | Description                                                       | Labels          |
| ----------------------------------- | ----------------------------------------------------------------- | --------------- |
| `fitbit_sleep_hours_asleep`         | Total hours asleep                                                | `date`          |
| `fitbit_sleep_hours_in_bed`         | Total hours in bed                                                | `date`          |
| `fitbit_sleep_efficiency`           | Sleep efficiency (0-100), computed as asleep / (asleep + awake)   | `date`          |
| `fitbit_sleep_stage_minutes`        | Minutes in each sleep stage                                       | `date`, `stage` |
| `fitbit_resting_heart_rate`         | Resting heart rate (bpm)                                          | `date`          |
| `fitbit_heart_rate_zone_minutes`    | Minutes in each HR zone (`light`, `moderate`, `vigorous`, `peak`) | `date`, `zone`  |
| `fitbit_hrv_daily_rmssd`            | Daily RMSSD HRV (ms)                                              | `date`          |
| `fitbit_hrv_deep_rmssd`             | Deep-sleep RMSSD HRV (ms)                                         | `date`          |
| `fitbit_skin_temp_nightly_relative` | Skin temp deviation from baseline (C)                             | `date`          |
| `fitbit_spo2_avg`                   | Average SpO2 %                                                    | `date`          |
| `fitbit_spo2_min`                   | Lower bound of SpO2 % during sleep                                | `date`          |
| `fitbit_spo2_max`                   | Upper bound of SpO2 % during sleep                                | `date`          |
| `fitbit_breathing_rate`             | Breathing rate (breaths/min)                                      | `date`          |
| `fitbit_steps`                      | Daily step count                                                  | `date`          |
| `fitbit_calories`                   | Daily calories burned                                             | `date`          |
| `fitbit_distance`                   | Daily distance (km)                                               | `date`          |
| `fitbit_distance_mi`                | Daily distance (miles)                                            | `date`          |
| `fitbit_floors`                     | Daily floors climbed                                              | `date`          |

## Routes

| Route            | Auth      | Description                                           |
| ---------------- | --------- | ----------------------------------------------------- |
| `GET /authorize` | None      | Starts Google OAuth2 flow (`?token=` to re-link)      |
| `GET /callback`  | Via state | OAuth2 callback, returns your API token               |
| `GET /metrics`   | Bearer    | Prometheus scrape endpoint (`?daysAgo=N` for history) |
| `GET /purge`     | Bearer    | Clears the KV response cache for your account         |
| `GET /doc`       | None      | OpenAPI 3.0 JSON spec                                 |
| `GET /reference` | None      | Scalar API reference UI                               |
| `GET /llms.txt`  | None      | Plain text README for LLMs                            |
| `GET /privacy`   | None      | Privacy policy                                        |

<br/>

---

# Development

## Setup

```sh
npm install
```

### Secrets

| Variable               | Description                        |
| ---------------------- | ---------------------------------- |
| `GOOGLE_CLIENT_ID`     | Google OAuth 2.0 web client ID     |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 web client secret |

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### Google Cloud setup

1. Create a Google Cloud project and enable the **Google Health API** (`health.googleapis.com`).
2. Google Auth Platform > Audience: user type External. **Publish the app to Production** (unverified apps are allowed for up to 100 users). In Testing mode refresh tokens expire after 7 days.
3. Data Access: add the `googlehealth.activity_and_fitness.readonly`, `googlehealth.health_metrics_and_measurements.readonly` and `googlehealth.sleep.readonly` scopes.
4. Clients: create a **Web application** client with the redirect URI `https://<your-domain>/callback`.

## Dev

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```
