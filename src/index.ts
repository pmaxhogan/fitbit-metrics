import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { marked } from "marked";
import readme from "../README.md";
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
import { kvKey, STATE_TTL_SECONDS } from "./consts";
import { dateRange, pooled } from "./utils";
import { requireAuth } from "./auth";

type AppEnv = { Bindings: Env; Variables: { userId: string } };

const app = new OpenAPIHono<AppEnv>();

// --- Auth middleware on protected routes ---
app.use("/metrics", requireAuth);
app.use("/purge", requireAuth);

// --- Route definitions ---

const authorizeRoute = createRoute({
  method: "get",
  path: "/authorize",
  tags: ["Auth"],
  summary: "Start Fitbit OAuth2 flow",
  description: "Redirects to Fitbit's authorization page. No authentication required.",
  responses: {
    302: { description: "Redirect to Fitbit OAuth2 authorization" },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Auth"],
  summary: "OAuth2 callback",
  description: "Handles the Fitbit OAuth2 callback. Returns an API token on success.",
  request: {
    query: z.object({
      code: z.string().openapi({ description: "Authorization code from Fitbit", example: "abc123" }),
      state: z.string().openapi({ description: "CSRF state token", example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      description: "Authorization successful, returns your API token",
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
            message: z.string(),
          }),
        },
      },
    },
    400: { description: "Missing query parameters" },
    403: { description: "Invalid or expired OAuth state" },
    502: { description: "Fitbit token exchange failed" },
  },
});

const metricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  tags: ["Metrics"],
  summary: "Prometheus scrape endpoint",
  description: "Returns Fitbit health data formatted as Prometheus metrics. Requires bearer token.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Prometheus-formatted metrics",
      content: { "text/plain": { schema: z.string() } },
    },
    401: { description: "Unauthorized" },
    500: { description: "Error fetching metrics" },
  },
});

const purgeRoute = createRoute({
  method: "get",
  path: "/purge",
  tags: ["Cache"],
  summary: "Purge cached Fitbit API responses",
  description: "Deletes all cached API responses for the authenticated user. Requires bearer token.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Cache purged",
      content: { "text/plain": { schema: z.string() } },
    },
    401: { description: "Unauthorized" },
  },
});

const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Info"],
  summary: "Landing page",
  responses: {
    200: {
      description: "HTML landing page",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Info"],
  summary: "Health check",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ status: z.string() }) } },
    },
  },
});

// --- Route handlers ---

app.openapi(authorizeRoute, async (c) => {
  const redirectUri = new URL("/callback", c.req.url).toString();
  const state = crypto.randomUUID();

  await c.env.FITBIT_KV.put(kvKey.oauthState(state), "1", {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.FITBIT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "sleep heartrate temperature oxygen_saturation respiratory_rate activity",
    state,
  });
  return c.redirect(`https://www.fitbit.com/oauth2/authorize?${params}`);
});

app.openapi(callbackRoute, async (c) => {
  const { code, state } = c.req.valid("query");

  const stateKey = kvKey.oauthState(state);
  const valid = await c.env.FITBIT_KV.get(stateKey);
  if (!valid) return c.text("Invalid or expired OAuth state", 403);
  await c.env.FITBIT_KV.delete(stateKey);

  const userId = crypto.randomUUID();
  const token = crypto.randomUUID();

  const redirectUri = new URL("/callback", c.req.url).toString();
  try {
    await exchangeAuthCode(c.env, userId, code, redirectUri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.text(message, 502);
  }

  await c.env.FITBIT_KV.put(kvKey.token(token), userId);

  return c.json({ token, message: "Fitbit authorization complete. Save this token! It's your API key." }, 200);
});

app.openapi(metricsRoute, async (c) => {
  const userId = c.get("userId");
  try {
    const accessToken = await getAccessToken(c.env, userId);
    const { start, end } = dateRange();
    const kv = c.env.FITBIT_KV;

    const results = await pooled<any>([
      () => fetchSleepRange(kv, userId, accessToken, start, end),
      () => fetchHeartRateRange(kv, userId, accessToken, start, end),
      () => fetchHrvRange(kv, userId, accessToken, start, end),
      () => fetchTempSkinRange(kv, userId, accessToken, start, end),
      () => fetchSpO2Range(kv, userId, accessToken, start, end),
      () => fetchBreathingRateRange(kv, userId, accessToken, start, end),
      () => fetchStepsRange(kv, userId, accessToken, start, end),
      () => fetchCaloriesRange(kv, userId, accessToken, start, end),
      () => fetchDistanceRange(kv, userId, accessToken, start, end),
      () => fetchFloorsRange(kv, userId, accessToken, start, end),
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

app.openapi(purgeRoute, async (c) => {
  const userId = c.get("userId");
  const kv = c.env.FITBIT_KV;
  const prefix = `user:${userId}:cache:`;
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const result = await kv.list({ prefix, cursor });
    await Promise.all(result.keys.map((k: { name: string }) => kv.delete(k.name)));
    deleted += result.keys.length;
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  console.log(`[purge] user=${userId} deleted ${deleted} cached keys`);
  return c.text(`Purged ${deleted} cached entries\n`);
});

app.openapi(rootRoute, (c) => {
  const html = marked.parse(readme) as string;
  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fitbit-metrics</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#333;line-height:1.6}
a{color:#0066cc}code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:.9em}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f9f9f9}</style></head>
<body>${html}</body></html>`);
});

app.openapi(healthRoute, (c) => {
  return c.json({ status: "ok" }, 200);
});

// --- OpenAPI doc + Scalar UI ---

app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "fitbit-metrics",
    version: "1.0.0",
    description: "Cloudflare Worker exposing Fitbit health data as Prometheus metrics",
  },
  security: [{ Bearer: [] }],
});

app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  description: "Token returned from the /callback endpoint after OAuth authorization",
});

app.get("/reference", Scalar({ url: "/doc", pageTitle: "fitbit-metrics API" }));

export default app;
