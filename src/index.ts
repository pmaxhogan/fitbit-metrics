import { Hono } from "hono";

type Bindings = {
  FITBIT_KV: KVNamespace;
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  FITBIT_INITIAL_REFRESH_TOKEN: string;
  METRICS_AUTH_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const KV_REFRESH_TOKEN_KEY = "fitbit_refresh_token";

async function getAccessToken(env: Bindings): Promise<string> {
  // Use the KV-stored refresh token if available, otherwise fall back to the initial secret
  const refreshToken =
    (await env.FITBIT_KV.get(KV_REFRESH_TOKEN_KEY)) ??
    env.FITBIT_INITIAL_REFRESH_TOKEN;

  const basicAuth = btoa(`${env.FITBIT_CLIENT_ID}:${env.FITBIT_CLIENT_SECRET}`);

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fitbit token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };

  // Fitbit rotates refresh tokens — persist the new one
  await env.FITBIT_KV.put(KV_REFRESH_TOKEN_KEY, data.refresh_token);

  return data.access_token;
}

interface FitbitSleepEntry {
  isMainSleep: boolean;
  duration: number; // milliseconds
  efficiency: number;
  minutesAsleep: number;
  startTime: string;
  endTime: string;
  dateOfSleep: string;
}

interface FitbitSleepResponse {
  sleep: FitbitSleepEntry[];
  summary: {
    totalMinutesAsleep: number;
    totalSleepRecords: number;
    totalTimeInBed: number;
  };
}

async function fetchSleepData(
  accessToken: string,
  date: string
): Promise<FitbitSleepResponse> {
  const url = `https://api.fitbit.com/1.2/user/-/sleep/date/${date}.json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fitbit sleep API failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<FitbitSleepResponse>;
}

function todayDateString(): string {
  // Fitbit dates are in the user's timezone — using UTC is close enough for daily metrics
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function formatPrometheus(sleep: FitbitSleepResponse, date: string): string {
  const lines: string[] = [];

  const mainSleep = sleep.sleep.find((s) => s.isMainSleep);
  const hoursAsleep = sleep.summary.totalMinutesAsleep / 60;
  const hoursInBed = sleep.summary.totalTimeInBed / 60;

  lines.push("# HELP fitbit_sleep_hours_asleep Total hours asleep for the night.");
  lines.push("# TYPE fitbit_sleep_hours_asleep gauge");
  lines.push(`fitbit_sleep_hours_asleep{date="${date}"} ${hoursAsleep.toFixed(2)}`);

  lines.push("# HELP fitbit_sleep_hours_in_bed Total hours in bed for the night.");
  lines.push("# TYPE fitbit_sleep_hours_in_bed gauge");
  lines.push(`fitbit_sleep_hours_in_bed{date="${date}"} ${hoursInBed.toFixed(2)}`);

  lines.push("# HELP fitbit_sleep_efficiency Sleep efficiency score (0-100).");
  lines.push("# TYPE fitbit_sleep_efficiency gauge");
  lines.push(
    `fitbit_sleep_efficiency{date="${date}"} ${mainSleep?.efficiency ?? 0}`
  );

  lines.push("# HELP fitbit_sleep_records Number of sleep records logged.");
  lines.push("# TYPE fitbit_sleep_records gauge");
  lines.push(
    `fitbit_sleep_records{date="${date}"} ${sleep.summary.totalSleepRecords}`
  );

  lines.push("");
  return lines.join("\n");
}

// --- Bearer auth middleware for all sensitive routes ---
import type { MiddlewareHandler } from "hono";

const requireAuth: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const expected = c.env.METRICS_AUTH_TOKEN;

  const authorized =
    authHeader === `Bearer ${expected}` || queryToken === expected;

  if (!authorized) {
    return c.text("Unauthorized\n", 401);
  }
  await next();
};

app.use("/metrics", requireAuth);
app.use("/authorize", requireAuth);
app.use("/callback", requireAuth);

app.get("/metrics", async (c) => {
  try {
    const accessToken = await getAccessToken(c.env);
    const date = todayDateString();
    const sleep = await fetchSleepData(accessToken, date);
    const body = formatPrometheus(sleep, date);
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

// --- OAuth2 callback: exchange authorization code for tokens ---
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing 'code' query parameter", 400);
  }

  const redirectUri = new URL("/callback", c.req.url).toString();
  const basicAuth = btoa(
    `${c.env.FITBIT_CLIENT_ID}:${c.env.FITBIT_CLIENT_SECRET}`
  );

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return c.text(`Token exchange failed (${res.status}): ${body}`, 502);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };

  // Store the refresh token in KV for future use
  await c.env.FITBIT_KV.put(KV_REFRESH_TOKEN_KEY, data.refresh_token);

  return c.text(
    "Fitbit authorization complete. Refresh token stored. You can close this tab."
  );
});

// --- Kick off the OAuth2 flow ---
app.get("/authorize", (c) => {
  const redirectUri = new URL("/callback", c.req.url).toString();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.FITBIT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "sleep",
  });
  return c.redirect(`https://www.fitbit.com/oauth2/authorize?${params}`);
});

app.get("/", (c) => {
  return c.text("fitbit-metrics worker — GET /metrics for prometheus scrape");
});

export default app;
