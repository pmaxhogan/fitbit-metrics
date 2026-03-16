import { MAX_RETRIES, CACHE_TTL_SECONDS, DATE_CHUNK_LIMIT } from "./consts";
import { dateChunks, pooled } from "./utils";

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

// Steps, calories, distance, floors all share this shape
export interface FitbitActivityTimeseriesEntry {
  dateTime: string;
  value: string;
}

export interface FitbitStepsResponse {
  "activities-steps": FitbitActivityTimeseriesEntry[];
}

export interface FitbitCaloriesResponse {
  "activities-calories": FitbitActivityTimeseriesEntry[];
}

export interface FitbitDistanceResponse {
  "activities-distance": FitbitActivityTimeseriesEntry[];
}

export interface FitbitFloorsResponse {
  "activities-floors": FitbitActivityTimeseriesEntry[];
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

// --- Typed fetch helpers ---

/** Simple range fetch — single API call, no chunking needed. */
function simpleRange<T>(pathTemplate: (s: string, e: string) => string) {
  return (kv: KVNamespace, accessToken: string, startDate: string, endDate: string): Promise<T> =>
    fitbitApi<T>(kv, accessToken, pathTemplate(startDate, endDate));
}

/** Chunked range fetch — splits into DATE_CHUNK_LIMIT-day windows, merges a top-level array key. */
function chunkedRange<T>(pathTemplate: (s: string, e: string) => string, key: keyof T) {
  return async (kv: KVNamespace, accessToken: string, startDate: string, endDate: string): Promise<T> => {
    const chunks = dateChunks(startDate, endDate, DATE_CHUNK_LIMIT);
    const results = await pooled(
      chunks.map(
        ([s, e]) =>
          () =>
            fitbitApi<T>(kv, accessToken, pathTemplate(s, e)),
      ),
    );
    return { [key]: results.flatMap((r) => r[key] as any[]) } as T;
  };
}

// --- Exported fetch functions ---

export const fetchSleepRange = simpleRange<FitbitSleepResponse>((s, e) => `/1.2/user/-/sleep/date/${s}/${e}.json`);

export const fetchHeartRateRange = simpleRange<FitbitHeartRateResponse>((s, e) => `/1/user/-/activities/heart/date/${s}/${e}.json`);

export const fetchSpO2Range = simpleRange<FitbitSpO2Response>((s, e) => `/1/user/-/spo2/date/${s}/${e}.json`);

export const fetchStepsRange = simpleRange<FitbitStepsResponse>((s, e) => `/1/user/-/activities/steps/date/${s}/${e}.json`);

export const fetchCaloriesRange = simpleRange<FitbitCaloriesResponse>((s, e) => `/1/user/-/activities/calories/date/${s}/${e}.json`);

export const fetchDistanceRange = simpleRange<FitbitDistanceResponse>((s, e) => `/1/user/-/activities/distance/date/${s}/${e}.json`);

export const fetchFloorsRange = simpleRange<FitbitFloorsResponse>((s, e) => `/1/user/-/activities/floors/date/${s}/${e}.json`);

// Chunked endpoints (30-day max range)

export const fetchHrvRange = chunkedRange<FitbitHrvResponse>((s, e) => `/1/user/-/hrv/date/${s}/${e}.json`, "hrv");

export const fetchTempSkinRange = chunkedRange<FitbitTempSkinResponse>((s, e) => `/1/user/-/temp/skin/date/${s}/${e}.json`, "tempSkin");

export const fetchBreathingRateRange = chunkedRange<FitbitBreathingRateResponse>((s, e) => `/1/user/-/br/date/${s}/${e}.json`, "br");
