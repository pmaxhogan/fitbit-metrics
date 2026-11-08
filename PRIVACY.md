# fitbit-metrics privacy policy

Last updated: 2026-11-08

fitbit-metrics is a personal, self-hosted tool that turns your own Fitbit / Google Health data into Prometheus metrics. It is operated by Max Hogan ([maxhogan.dev](https://maxhogan.dev)).

## What it accesses

When you authorize it with Google, it requests read-only access to your Google Health data (`googlehealth.activity_and_fitness.readonly`, `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.sleep.readonly`). It reads daily summaries only: steps, distance, floors, calories, heart-rate zones, resting heart rate, heart-rate variability, SpO2, breathing rate, skin temperature and sleep. It never writes to your Google account.

## What it stores

- Your Google OAuth refresh token and a short-lived access token, so it can read your data when your Prometheus server scrapes `/metrics`.
- A random API token that identifies you to `/metrics`.
- Cached copies of the API responses, for 12 hours (current window) or 7 days (historical windows), to avoid repeated requests.

All of this is kept in Cloudflare Workers KV. Nothing else is collected: no analytics, no cookies beyond a short-lived one that protects the sign-in flow.

## Who can see it

Only whoever holds your API token can read your metrics. Your data is not sold, shared with, or transferred to anyone, and is not used for advertising or to train AI models. Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Removing your data

- `GET /purge` with your token deletes all cached responses.
- Revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions); the stored refresh token then stops working.
- To have the stored tokens deleted entirely, email max@maxhogan.dev.
