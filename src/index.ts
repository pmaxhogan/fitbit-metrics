import { Hono } from "hono";
import {
  fetchSleepRange,
  fetchHeartRateRange,
  fetchHrvRange,
  fetchTempSkinRange,
  fetchSpO2Range,
  fetchBreathingRateRange,
  fetchStepsRange,
  fetchCaloriesRange,
  fetchDistanceRange,
  fetchFloorsRange,
} from "./fitbit";
import { formatPrometheus, type MetricsData } from "./prom";
import { exchangeAuthCode, getAccessToken } from "./fitbit-auth";
import type { Bindings } from "./consts";
import { dateRange, pooled } from "./utils";
import { checkToken, requireAuth } from "./auth";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/purge", requireAuth);
app.use("/", requireAuth);
app.use("/metrics", requireAuth);
app.use("/authorize", requireAuth);

app.use("/callback", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const stateToken = c.req.query("state");
  const expected = c.env.METRICS_AUTH_TOKEN;

  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (checkToken(bearerToken, expected) || checkToken(stateToken, expected)) {
    await next();
  } else {
    return c.text("Unauthorized\n", 401);
  }
});

app.get("/metrics", async (c) => {
  try {
    const accessToken = await getAccessToken(c.env);
    const { start, end } = dateRange();
    const kv = c.env.FITBIT_KV;

    // pooled limits concurrency to respect Workers' 6 simultaneous connection limit
    const results = await pooled<any>([
      () => fetchSleepRange(kv, accessToken, start, end),
      () => fetchHeartRateRange(kv, accessToken, start, end),
      () => fetchHrvRange(kv, accessToken, start, end),
      () => fetchTempSkinRange(kv, accessToken, start, end),
      () => fetchSpO2Range(kv, accessToken, start, end),
      () => fetchBreathingRateRange(kv, accessToken, start, end),
      () => fetchStepsRange(kv, accessToken, start, end),
      () => fetchCaloriesRange(kv, accessToken, start, end),
      () => fetchDistanceRange(kv, accessToken, start, end),
      () => fetchFloorsRange(kv, accessToken, start, end),
    ]);

    const data: MetricsData = {
      sleep: results[0],
      heartRate: results[1],
      hrv: results[2],
      tempSkin: results[3],
      spo2: results[4],
      br: results[5],
      steps: results[6],
      calories: results[7],
      distance: results[8],
      floors: results[9],
    };
    const body = formatPrometheus(data);
    return c.text(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("metrics error:", message);
    return c.text(`# error fetching metrics: ${message}\n`, 500, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  }
});

app.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing 'code' query parameter", 400);
  }

  const redirectUri = new URL("/callback", c.req.url).toString();
  try {
    await exchangeAuthCode(c.env, code, redirectUri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.text(message, 502);
  }

  return c.text("Fitbit authorization complete. Refresh token stored. You can close this tab.");
});

app.get("/authorize", (c) => {
  const redirectUri = new URL("/callback", c.req.url).toString();
  const token = c.req.query("token") ?? "";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.FITBIT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "sleep heartrate temperature oxygen_saturation respiratory_rate activity",
    state: token,
  });
  return c.redirect(`https://www.fitbit.com/oauth2/authorize?${params}`);
});

app.get("/purge", async (c) => {
  const kv = c.env.FITBIT_KV;
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const result = await kv.list({ prefix: "fitbit_cache:", cursor });
    await Promise.all(result.keys.map((k: { name: string }) => kv.delete(k.name)));
    deleted += result.keys.length;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  console.log(`[purge] deleted ${deleted} cached keys`);
  return c.text(`Purged ${deleted} cached entries\n`);
});

app.get("/", (c) => {
  return c.text("fitbit-metrics worker — GET /metrics for prometheus scrape");
});

export default app;
