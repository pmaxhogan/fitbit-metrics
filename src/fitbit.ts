// --- Bindings type (shared) ---

import {
  KV_REFRESH_TOKEN_KEY,
  FITBIT_TOKEN_URL,
  MAX_CONCURRENCY,
  MAX_RETRIES,
  CACHE_TTL_SECONDS,
  LOOKBACK_DAYS,
  DATE_CHUNK_LIMIT,
} from "./consts";
import { dateChunks } from "./utils";

// --- Response types ---

export interface StageSummary {
  count: number;
  minutes: number;
  thirtyDayAvgMinutes?: number;
}

export interface FitbitSleepEntry {
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

export interface FitbitSleepResponse {
  sleep: FitbitSleepEntry[];
}

export interface FitbitHrvEntry {
  dateTime: string;
  value: { dailyRmssd: number; deepRmssd: number };
}

export interface FitbitHrvResponse {
  hrv: FitbitHrvEntry[];
}

export interface HeartRateZone {
  caloriesOut: number;
  max: number;
  min: number;
  minutes: number;
  name: string;
}

export interface FitbitHeartRateEntry {
  dateTime: string;
  value: {
    customHeartRateZones: HeartRateZone[];
    heartRateZones: HeartRateZone[];
    restingHeartRate?: number;
  };
}

export interface FitbitHeartRateResponse {
  "activities-heart": FitbitHeartRateEntry[];
}

export interface FitbitTempSkinEntry {
  dateTime: string;
  value: { nightlyRelative: number };
  logType: string;
}

export interface FitbitTempSkinResponse {
  tempSkin: FitbitTempSkinEntry[];
}

export interface FitbitSpO2Entry {
  dateTime: string;
  value: { avg: number; min: number; max: number };
}

// SpO2 range endpoint returns a raw array, not wrapped in an object
export type FitbitSpO2Response = FitbitSpO2Entry[];

export interface FitbitBreathingRateEntry {
  dateTime: string;
  value: { breathingRate: number };
}

export interface FitbitBreathingRateResponse {
  br: FitbitBreathingRateEntry[];
}
export interface FitbitStepsEntry {
  dateTime: string;
  value: string;
}

export interface FitbitStepsResponse {
  "activities-steps": FitbitStepsEntry[];
}

// --- Concurrency-limited pool ---

async function pooled<T>(tasks: (() => Promise<T>)[], concurrency = MAX_CONCURRENCY): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// --- Fitbit API wrapper: caching, 429 backoff, rate-limit awareness, logging ---

async function fitbitApi<T>(kv: KVNamespace, accessToken: string, path: string): Promise<T> {
  const cacheKey = `fitbit_cache:${path}`;

  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    console.log(`[fitbit] cache hit: ${path}`);
    return JSON.parse(cached) as T;
  }
  console.log(`[fitbit] cache miss: ${path}`);

  const url = `https://api.fitbit.com${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Log rate-limit headers when present
    const remaining = res.headers.get("Fitbit-Rate-Limit-Remaining");
    const resetSecs = res.headers.get("Fitbit-Rate-Limit-Reset");
    const ratePart = remaining !== null ? ` [remaining=${remaining} reset=${resetSecs}s]` : "";

    console.log(`[fitbit] ${path} -> ${res.status}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}${ratePart}`);

    if (res.status === 429) {
      // Prefer Fitbit-Rate-Limit-Reset (seconds until quota resets at top of hour)
      const waitMs = resetSecs ? parseInt(resetSecs, 10) * 1000 : 1000 * 2 ** attempt;
      console.log(`[fitbit] 429 on ${path}, waiting ${(waitMs / 1000).toFixed(0)}s for rate limit reset`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fitbit API ${path} failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as T;

    await kv.put(cacheKey, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
    console.log(`[fitbit] cached: ${path} (ttl ${CACHE_TTL_SECONDS}s)`);

    // If rate limit is getting tight, pause before returning so the next
    // pooled task doesn't immediately fire into a 429
    if (remaining !== null && parseInt(remaining, 10) <= 5 && resetSecs) {
      const pauseMs = parseInt(resetSecs, 10) * 1000;
      console.log(`[fitbit] rate limit low (${remaining} left), pausing ${(pauseMs / 1000).toFixed(0)}s`);
      await new Promise((r) => setTimeout(r, pauseMs));
    }

    return data;
  }

  throw new Error(`Fitbit API ${path}: max retries exceeded (429)`);
}

// --- Date helpers ---

// --- Typed fetch functions ---

export async function fetchSleepRange(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitSleepResponse> {
  return fitbitApi<FitbitSleepResponse>(kv, accessToken, `/1.2/user/-/sleep/date/${startDate}/${endDate}.json`);
}

export async function fetchHeartRateRange(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitHeartRateResponse> {
  return fitbitApi<FitbitHeartRateResponse>(kv, accessToken, `/1/user/-/activities/heart/date/${startDate}/${endDate}.json`);
}

export async function fetchHrvRange(kv: KVNamespace, accessToken: string, startDate: string, endDate: string): Promise<FitbitHrvResponse> {
  const chunks = dateChunks(startDate, endDate, DATE_CHUNK_LIMIT);
  const results = await pooled(
    chunks.map(
      ([s, e]) =>
        () =>
          fitbitApi<FitbitHrvResponse>(kv, accessToken, `/1/user/-/hrv/date/${s}/${e}.json`),
    ),
  );
  return { hrv: results.flatMap((r) => r.hrv) };
}

// Skin temp API supports date ranges with a 30-day max — chunk like HRV
export async function fetchTempSkinRange(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitTempSkinResponse> {
  const chunks = dateChunks(startDate, endDate, DATE_CHUNK_LIMIT);
  const results = await pooled(
    chunks.map(
      ([s, e]) =>
        () =>
          fitbitApi<FitbitTempSkinResponse>(kv, accessToken, `/1/user/-/temp/skin/date/${s}/${e}.json`),
    ),
  );
  return { tempSkin: results.flatMap((r) => r.tempSkin) };
}

// SpO2 range endpoint — no range limit, returns raw array
export async function fetchSpO2Range(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitSpO2Response> {
  return fitbitApi<FitbitSpO2Response>(kv, accessToken, `/1/user/-/spo2/date/${startDate}/${endDate}.json`);
}

export async function fetchStepsRange(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitStepsResponse> {
  return fitbitApi<FitbitStepsResponse>(kv, accessToken, `/1/user/-/activities/steps/date/${startDate}/${endDate}.json`);
}

// Breathing rate — 30-day max range, chunk like HRV
export async function fetchBreathingRateRange(
  kv: KVNamespace,
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FitbitBreathingRateResponse> {
  const chunks = dateChunks(startDate, endDate, DATE_CHUNK_LIMIT);
  const results = await pooled(
    chunks.map(
      ([s, e]) =>
        () =>
          fitbitApi<FitbitBreathingRateResponse>(kv, accessToken, `/1/user/-/br/date/${s}/${e}.json`),
    ),
  );
  return { br: results.flatMap((r) => r.br) };
}
