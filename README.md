# fitbit-metrics`.maxhogan.dev`

Convert Fitbit health data into Prometheus metrics.

Cloudflare Worker that exposes Fitbit health data as a Prometheus-compatible `/metrics` endpoint. Built with [Hono](https://hono.dev/) + TS.

## Requirements

1. Prometheus
2. A Fitbit account

## Steps

1. [Authorize](/authorize) this app with your Fitbit account
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

## Links

- [Authorize with Fitbit](/authorize)
- [API Reference](/reference) ([OpenAPI](/doc))
- [GitHub](https://github.com/pmaxhogan/fitbit-metrics)
- [My Website](https://maxhogan.dev)

---

# Development

## Routes

| Route            | Auth      | Description                                   |
| ---------------- | --------- | --------------------------------------------- |
| `GET /authorize` | None      | Starts Fitbit OAuth2 flow                     |
| `GET /callback`  | Via state | OAuth2 callback, returns your API token       |
| `GET /metrics`   | Bearer    | Prometheus scrape endpoint                    |
| `GET /purge`     | Bearer    | Clears the KV response cache for your account |
| `GET /doc`       | None      | OpenAPI 3.0 JSON spec                         |
| `GET /reference` | None      | Scalar API reference UI                       |

## Setup

```sh
npm install
```

### Secrets

| Variable               | Description              |
| ---------------------- | ------------------------ |
| `FITBIT_CLIENT_ID`     | Fitbit app client ID     |
| `FITBIT_CLIENT_SECRET` | Fitbit app client secret |

```sh
npx wrangler secret put FITBIT_CLIENT_ID
npx wrangler secret put FITBIT_CLIENT_SECRET
```

## Dev

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```
