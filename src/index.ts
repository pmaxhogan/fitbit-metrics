import { Hono } from "hono";

type Bindings = {
  FITBIT_KV: KVNamespace;
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  METRICS_AUTH_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const KV_REFRESH_TOKEN_KEY = "fitbit_refresh_token";

async function getAccessToken(env: Bindings): Promise<string> {
  // Use the KV-stored refresh token if available, otherwise fall back to the initial secret
  const refreshToken = await env.FITBIT_KV.get(KV_REFRESH_TOKEN_KEY);

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

interface StageSummary {
  count: number;
  minutes: number;
  thirtyDayAvgMinutes?: number;
}

interface FitbitSleepEntry {
  isMainSleep: boolean;
  duration: number;
  efficiency: number;
  minutesAsleep: number;
  minutesAwake: number;
  timeInBed: number;
  startTime: string;
  endTime: string;
  dateOfSleep: string;
  type: "classic" | "stages";
  levels: {
    summary: Record<string, StageSummary>;
  };
}

interface FitbitSleepResponse {
  sleep: FitbitSleepEntry[];
}

interface FitbitHrvEntry {
  dateTime: string;
  value: {
    dailyRmssd: number;
    deepRmssd: number;
  };
}

interface FitbitHrvResponse {
  hrv: FitbitHrvEntry[];
}

interface HeartRateZone {
  caloriesOut: number;
  max: number;
  min: number;
  minutes: number;
  name: string;
}

interface FitbitHeartRateEntry {
  dateTime: string;
  value: {
    customHeartRateZones: HeartRateZone[];
    heartRateZones: HeartRateZone[];
    restingHeartRate?: number;
  };
}

interface FitbitHeartRateResponse {
  "activities-heart": FitbitHeartRateEntry[];
}

const LOOKBACK_DAYS = 90;

async function fetchSleepRange(
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<FitbitSleepResponse> {
  const url = `https://api.fitbit.com/1.2/user/-/sleep/date/${startDate}/${endDate}.json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fitbit sleep API failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<FitbitSleepResponse>;
}

async function fetchHeartRateRange(
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<FitbitHeartRateResponse> {
  const url = `https://api.fitbit.com/1/user/-/activities/heart/date/${startDate}/${endDate}.json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fitbit heart rate API failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<FitbitHeartRateResponse>;
}

// HRV API has a 30-day max range, so we chunk the lookback window
async function fetchHrvRange(
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<FitbitHrvResponse> {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const allEntries: FitbitHrvEntry[] = [];

  let cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(
      Math.min(cursor.getTime() + 29 * 86400000, end.getTime())
    );
    const s = cursor.toISOString().slice(0, 10);
    const e = chunkEnd.toISOString().slice(0, 10);

    const url = `https://api.fitbit.com/1/user/-/hrv/date/${s}/${e}.json`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fitbit HRV API failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as FitbitHrvResponse;
    allEntries.push(...data.hrv);

    cursor = new Date(chunkEnd.getTime() + 86400000);
  }

  return { hrv: allEntries };
}

function dateRange(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - LOOKBACK_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

function formatPrometheus(
  sleepData: FitbitSleepResponse,
  heartData: FitbitHeartRateResponse,
  hrvData: FitbitHrvResponse
): string {
  const lines: string[] = [];

  // --- Sleep metrics ---
  const mainSleeps = sleepData.sleep.filter((s) => s.isMainSleep);

  lines.push("# HELP fitbit_sleep_hours_asleep Total hours asleep.");
  lines.push("# TYPE fitbit_sleep_hours_asleep gauge");
  for (const s of mainSleeps) {
    lines.push(
      `fitbit_sleep_hours_asleep{date="${s.dateOfSleep}"} ${(s.minutesAsleep / 60).toFixed(2)}`
    );
  }

  lines.push("# HELP fitbit_sleep_hours_in_bed Total hours in bed.");
  lines.push("# TYPE fitbit_sleep_hours_in_bed gauge");
  for (const s of mainSleeps) {
    lines.push(
      `fitbit_sleep_hours_in_bed{date="${s.dateOfSleep}"} ${(s.timeInBed / 60).toFixed(2)}`
    );
  }

  lines.push("# HELP fitbit_sleep_efficiency Sleep efficiency score (0-100).");
  lines.push("# TYPE fitbit_sleep_efficiency gauge");
  for (const s of mainSleeps) {
    lines.push(
      `fitbit_sleep_efficiency{date="${s.dateOfSleep}"} ${s.efficiency}`
    );
  }

  lines.push(
    "# HELP fitbit_sleep_stage_minutes Minutes spent in each sleep stage."
  );
  lines.push("# TYPE fitbit_sleep_stage_minutes gauge");
  for (const s of mainSleeps) {
    for (const [stage, info] of Object.entries(s.levels.summary)) {
      lines.push(
        `fitbit_sleep_stage_minutes{date="${s.dateOfSleep}",stage="${stage}"} ${info.minutes}`
      );
    }
  }

  // --- Resting heart rate ---
  lines.push(
    "# HELP fitbit_resting_heart_rate Resting heart rate in bpm."
  );
  lines.push("# TYPE fitbit_resting_heart_rate gauge");
  for (const entry of heartData["activities-heart"]) {
    if (entry.value.restingHeartRate != null) {
      lines.push(
        `fitbit_resting_heart_rate{date="${entry.dateTime}"} ${entry.value.restingHeartRate}`
      );
    }
  }

  // --- Heart rate zone minutes ---
  lines.push(
    "# HELP fitbit_heart_rate_zone_minutes Minutes in each heart rate zone."
  );
  lines.push("# TYPE fitbit_heart_rate_zone_minutes gauge");
  for (const entry of heartData["activities-heart"]) {
    for (const zone of entry.value.heartRateZones) {
      lines.push(
        `fitbit_heart_rate_zone_minutes{date="${entry.dateTime}",zone="${zone.name}"} ${zone.minutes}`
      );
    }
  }

  // --- HRV ---
  lines.push(
    "# HELP fitbit_hrv_daily_rmssd Daily RMSSD heart rate variability (ms)."
  );
  lines.push("# TYPE fitbit_hrv_daily_rmssd gauge");
  for (const entry of hrvData.hrv) {
    lines.push(
      `fitbit_hrv_daily_rmssd{date="${entry.dateTime}"} ${entry.value.dailyRmssd.toFixed(3)}`
    );
  }

  lines.push(
    "# HELP fitbit_hrv_deep_rmssd Deep-sleep RMSSD heart rate variability (ms)."
  );
  lines.push("# TYPE fitbit_hrv_deep_rmssd gauge");
  for (const entry of hrvData.hrv) {
    lines.push(
      `fitbit_hrv_deep_rmssd{date="${entry.dateTime}"} ${entry.value.deepRmssd.toFixed(3)}`
    );
  }

  lines.push("");
  return lines.join("\n");
}

// --- Bearer auth middleware for all sensitive routes ---
import type { MiddlewareHandler } from "hono";

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    // Compare against self to burn constant time, then return false
    crypto.subtle.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}

const requireAuth: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const expected = c.env.METRICS_AUTH_TOKEN;

  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (checkToken(bearerToken, expected) || checkToken(queryToken, expected)) {
    await next();
  } else {
    return c.text("Unauthorized\n", 401);
  }
};

app.use("/", requireAuth);
app.use("/metrics", requireAuth);
app.use("/authorize", requireAuth);
// --- Callback: auth comes via the state param Fitbit echoes back ---
app.use("/callback", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const stateToken = c.req.query("state");
  const expected = c.env.METRICS_AUTH_TOKEN;

  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

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
    const [sleep, heartRate, hrv] = await Promise.all([
      fetchSleepRange(accessToken, start, end),
      fetchHeartRateRange(accessToken, start, end),
      fetchHrvRange(accessToken, start, end),
    ]);
    const body = formatPrometheus(sleep, heartRate, hrv);
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
  const token = c.req.query("token") ?? "";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.FITBIT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "sleep heartrate",
    state: token,
  });
  return c.redirect(`https://www.fitbit.com/oauth2/authorize?${params}`);
});

app.get("/", (c) => {
  return c.text("fitbit-metrics worker — GET /metrics for prometheus scrape");
});

export default app;
