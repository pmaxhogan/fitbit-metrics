import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { marked } from "marked";
import readme from "../README.md";
import {
  fetchSleep,
  fetchRestingHeartRate,
  fetchHrZones,
  fetchHrv,
  fetchSkinTemp,
  fetchSpO2,
  fetchBreathingRate,
  fetchSteps,
  fetchCalories,
  fetchDistanceKm,
  fetchFloors,
  healthApi,
  type ApiCtx,
} from "./health";
import { formatPrometheus, type MetricsData } from "./prom";
import { exchangeAuthCode, getAccessToken } from "./google-auth";
import { kvKey, STATE_TTL_SECONDS, CACHE_TTL_SECONDS, HISTORICAL_CACHE_TTL_SECONDS, GOOGLE_AUTH_URL, SCOPES, HEALTH_USER } from "./consts";
import { dateRange } from "./utils";
import { requireAuth, resolveToken } from "./auth";

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
  summary: "Start Google Health OAuth2 flow",
  description:
    "Redirects to Google's authorization page. No authentication required. " +
    "Pass ?token=<existing API token> to re-link an existing account: the same API token keeps working afterwards.",
  request: {
    query: z.object({
      token: z
        .string()
        .optional()
        .openapi({ description: "Existing API token to re-link (optional)", example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    302: { description: "Redirect to Google OAuth2 authorization" },
    401: { description: "The token passed to re-link is not valid" },
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
      code: z.string().optional().openapi({ description: "Authorization code from Google", example: "abc123" }),
      state: z.string().openapi({ description: "CSRF state token", example: "550e8400-e29b-41d4-a716-446655440000" }),
      error: z.string().optional().openapi({ description: "OAuth error from Google, e.g. access_denied" }),
    }),
  },
  responses: {
    200: {
      description: "Authorization successful, returns your API token",
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().nullable().openapi({ example: "550e8400-e29b-41d4-a716-446655440000", description: "null when re-linking" }),
            message: z.string(),
          }),
        },
      },
    },
    400: { description: "Missing query parameters or authorization denied" },
    403: { description: "Invalid or expired OAuth state" },
    502: { description: "Google token exchange failed" },
  },
});

const metricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  tags: ["Metrics"],
  summary: "Prometheus scrape endpoint",
  description:
    "Returns Fitbit health data (via the Google Health API) formatted as Prometheus metrics. Requires bearer token. " +
    "By default returns the most recent 30 days; pass ?daysAgo to shift the 30-day window further into the past (e.g. 30, 60, 90) to backfill historical data.",
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      daysAgo: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .openapi({
          param: { name: "daysAgo", in: "query" },
          description:
            "Shift the 30-day window this many days into the past. 0 (default) = most recent 30 days; 30 = the 30 days before that; 60, 90, ... reach further back. Windows with daysAgo>0 are immutable and cached for longer.",
          example: 0,
        }),
    }),
  },
  responses: {
    200: {
      description: "Prometheus-formatted metrics",
      content: { "text/plain": { schema: z.string() } },
    },
    400: { description: "Invalid query parameter (daysAgo must be a non-negative integer)" },
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

const llmsTxtRoute = createRoute({
  method: "get",
  path: "/llms.txt",
  tags: ["Info"],
  summary: "LLM-friendly plain text description",
  responses: {
    200: {
      description: "Plain text README for LLMs",
      content: { "text/plain": { schema: z.string() } },
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

  // Re-link: carry the existing userId through the OAuth state so the user's
  // API token (e.g. the one in prometheus.yml) keeps working.
  const { token } = c.req.valid("query");
  let relinkUserId: string | null = null;
  if (token) {
    relinkUserId = await resolveToken(c.env.FITBIT_KV, token);
    if (!relinkUserId) return c.text("Invalid token: cannot re-link. Omit ?token= to create a new one.", 401);
  }

  await c.env.FITBIT_KV.put(kvKey.oauthState(state), JSON.stringify({ userId: relinkUserId, relink: relinkUserId !== null }), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

app.openapi(callbackRoute, async (c) => {
  const { code, state, error } = c.req.valid("query");

  const stateKey = kvKey.oauthState(state);
  const stored = await c.env.FITBIT_KV.get(stateKey);
  if (!stored) return c.text("Invalid or expired OAuth state", 403);
  await c.env.FITBIT_KV.delete(stateKey);

  if (error || !code) return c.text(`Authorization failed: ${error ?? "no code returned"}`, 400);

  let relinkUserId: string | null = null;
  try {
    relinkUserId = (JSON.parse(stored) as { userId?: string | null }).userId ?? null;
  } catch {
    // not JSON: treat as a new user
  }

  const userId = relinkUserId ?? crypto.randomUUID();
  const redirectUri = new URL("/callback", c.req.url).toString();
  let accessToken: string;
  try {
    // Drop any cached access token so the fresh one is used immediately.
    await c.env.FITBIT_KV.delete(kvKey.accessToken(userId));
    accessToken = await exchangeAuthCode(c.env, userId, code, redirectUri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.text(message, 502);
  }

  // Confirm the Google account has a Google Health (Fitbit) profile.
  let linked = "Google Health account linked.";
  try {
    const ctx: ApiCtx = { kv: c.env.FITBIT_KV, userId, accessToken, cacheTtl: 60 };
    await healthApi(ctx, { method: "GET", path: `${HEALTH_USER}/identity`, query: { t: String(Date.now()) } });
  } catch (err) {
    linked = `Warning: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (relinkUserId) {
    return c.json({ token: null, message: `Re-linked. Your existing API token keeps working. ${linked}` }, 200);
  }

  const token = crypto.randomUUID();
  await c.env.FITBIT_KV.put(kvKey.token(token), userId);
  return c.json({ token, message: `Authorization complete. Save this token! It's your API key. ${linked}` }, 200);
});

app.openapi(metricsRoute, async (c) => {
  const userId = c.get("userId");
  const { daysAgo } = c.req.valid("query");
  try {
    const accessToken = await getAccessToken(c.env, userId);
    const { start, end } = dateRange(daysAgo);
    // Historical windows (daysAgo>0) are in the past and never change, so cache
    // them far longer than the current window (which Fitbit may still revise).
    const cacheTtl = daysAgo > 0 ? HISTORICAL_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
    const ctx: ApiCtx = { kv: c.env.FITBIT_KV, userId, accessToken, cacheTtl };

    // Workers allow 6 concurrent outgoing connections; extra fetches queue in the runtime.
    const [sleep, restingHeartRate, hrZones, hrv, skinTemp, spo2, breathingRate, steps, calories, distanceKm, floors] = await Promise.all([
      fetchSleep(ctx, start, end),
      fetchRestingHeartRate(ctx, start, end),
      fetchHrZones(ctx, start, end),
      fetchHrv(ctx, start, end),
      fetchSkinTemp(ctx, start, end),
      fetchSpO2(ctx, start, end),
      fetchBreathingRate(ctx, start, end),
      fetchSteps(ctx, start, end),
      fetchCalories(ctx, start, end),
      fetchDistanceKm(ctx, start, end),
      fetchFloors(ctx, start, end),
    ]);

    const data: MetricsData = { sleep, restingHeartRate, hrZones, hrv, skinTemp, spo2, breathingRate, steps, calories, distanceKm, floors };
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
  const prefix = kvKey.cachePrefix(userId);
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

app.openapi(llmsTxtRoute, (c) => {
  return c.text(readme, 200, { "Content-Type": "text/plain; charset=utf-8" });
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
