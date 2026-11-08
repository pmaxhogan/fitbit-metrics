import { MAX_RETRIES, HEALTH_API_BASE, HEALTH_USER, DATA_SOURCE_FAMILY, kvKey } from "./consts";
import { addDays, dateChunks, pooled } from "./utils";

// --- Google Health API v4 response shapes (only the fields we read) ---
// int64 fields (counts, minutes, bpm) arrive as JSON strings.

export interface GDate {
  year: number;
  month: number;
  day: number;
}

interface CivilDateTime {
  date: GDate;
}

export interface SleepPoint {
  type?: "SLEEP_TYPE_UNSPECIFIED" | "CLASSIC" | "STAGES";
  interval: { startTime: string; endTime: string; civilStartTime?: CivilDateTime; civilEndTime?: CivilDateTime };
  metadata?: { mainSleep?: boolean; nap?: boolean };
  summary?: {
    minutesAsleep?: string;
    minutesAwake?: string;
    minutesInSleepPeriod?: string;
    stagesSummary?: { type: string; minutes?: string; count?: string }[];
  };
}

export interface DataPoint {
  sleep?: SleepPoint;
  dailyRestingHeartRate?: { date: GDate; beatsPerMinute?: string };
  dailyHeartRateVariability?: {
    date: GDate;
    averageHeartRateVariabilityMilliseconds?: number;
    deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds?: number;
  };
  dailyOxygenSaturation?: { date: GDate; averagePercentage?: number; lowerBoundPercentage?: number; upperBoundPercentage?: number };
  dailyRespiratoryRate?: { date: GDate; breathsPerMinute?: number };
  dailySleepTemperatureDerivations?: { date: GDate; nightlyTemperatureCelsius?: number; baselineTemperatureCelsius?: number };
}

interface ListDataPointsResponse {
  dataPoints?: DataPoint[];
  nextPageToken?: string;
}

export interface RollupPoint {
  civilStartTime: CivilDateTime;
  civilEndTime?: CivilDateTime;
  steps?: { countSum?: string };
  distance?: { millimetersSum?: string };
  floors?: { countSum?: string };
  totalCalories?: { kcalSum?: number };
  timeInHeartRateZone?: { timeInHeartRateZones?: { heartRateZone: string; duration?: string }[] };
}

interface DailyRollUpResponse {
  rollupDataPoints?: RollupPoint[];
  nextPageToken?: string;
}

// --- Normalized shapes consumed by prom.ts ---

export interface DailyValue {
  date: string;
  value: number;
}

export interface SleepNight {
  date: string;
  isMainSleep: boolean;
  minutesAsleep: number;
  minutesInBed: number;
  efficiency: number | null;
  stages: Record<string, number>;
}

export interface HrZoneDay {
  date: string;
  zones: { name: string; minutes: number }[];
}

export interface HrvDay {
  date: string;
  dailyRmssd?: number;
  deepRmssd?: number;
}

export interface SpO2Day {
  date: string;
  avg: number;
  min?: number;
  max?: number;
}

// --- Helpers ---

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDate(d: GDate): string {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

export function toGDate(s: string): GDate {
  const [year, month, day] = s.split("-").map(Number);
  return { year, month, day };
}

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Parse a protobuf Duration string ("3600s", "12.5s") into seconds. */
export function durationSeconds(d: string | undefined): number {
  if (!d) return 0;
  const n = parseFloat(d.replace(/s$/, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Keep the first entry per date (list results are newest-first; one source per day is expected). */
function dedupeByDate<T extends { date: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true))).sort((a, b) => a.date.localeCompare(b.date));
}

// --- API client: caching, retry/backoff, readable errors ---

export interface ApiCtx {
  kv: KVNamespace;
  userId: string;
  accessToken: string;
  cacheTtl: number;
}

interface ApiRequest {
  method: "GET" | "POST";
  path: string; // relative to HEALTH_API_BASE, e.g. "users/me/dataTypes/steps/dataPoints:dailyRollUp"
  query?: Record<string, string>;
  body?: unknown;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function describeApiError(status: number, body: string): string {
  if (body.includes("ACCOUNT_NOT_LINKED")) {
    return (
      `Google Health API: account not linked (${status}). Sign in to the Google Health (Fitbit) app with this Google account ` +
      `and migrate the Fitbit account, see https://fitbit.google.com/auth/signup`
    );
  }
  try {
    const err = (JSON.parse(body) as { error?: { status?: string; message?: string } }).error;
    if (err?.message) return `${status} ${err.status ?? ""}: ${err.message}`.trim();
  } catch {
    // not JSON
  }
  return `${status}: ${body}`;
}

export async function healthApi<T>(ctx: ApiCtx, req: ApiRequest): Promise<T> {
  const qs = req.query ? `?${new URLSearchParams(req.query)}` : "";
  const bodyStr = req.body === undefined ? undefined : JSON.stringify(req.body);
  const label = `${req.method} ${req.path}${qs}${bodyStr ? ` ${bodyStr}` : ""}`;
  // The cache key embeds the method, path, query and body (which carry the date
  // range), so each distinct window, e.g. different ?daysAgo values, caches independently.
  const cacheKey = kvKey.cache(ctx.userId, `gh:${label}`);

  const cached = await ctx.kv.get(cacheKey);
  if (cached !== null) {
    console.log(`[health] cache hit: ${label}`);
    return JSON.parse(cached) as T;
  }

  const url = `${HEALTH_API_BASE}/${req.path}${qs}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        ...(bodyStr ? { "Content-Type": "application/json" } : {}),
      },
      body: bodyStr,
    });
    console.log(`[health] ${label} -> ${res.status}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);

    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "", 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Google Health API ${req.path}: ${describeApiError(res.status, await res.text())}`);
    }

    const data = (await res.json()) as T;
    await ctx.kv.put(cacheKey, JSON.stringify(data), { expirationTtl: ctx.cacheTtl });
    return data;
  }
  throw new Error(`Google Health API ${req.path}: max retries exceeded`);
}

const dataPointsPath = (dataType: string) => `${HEALTH_USER}/dataTypes/${dataType}/dataPoints`;

/** List all data points matching a filter, following nextPageToken. */
async function listAll(ctx: ApiCtx, dataType: string, filter: string, pageSize: number, dataSourceFamily?: string): Promise<DataPoint[]> {
  const out: DataPoint[] = [];
  let pageToken: string | undefined;
  do {
    const query: Record<string, string> = { filter, pageSize: String(pageSize) };
    if (dataSourceFamily) query.dataSourceFamily = dataSourceFamily;
    if (pageToken) query.pageToken = pageToken;
    const res = await healthApi<ListDataPointsResponse>(ctx, { method: "GET", path: dataPointsPath(dataType), query });
    out.push(...(res.dataPoints ?? []));
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

/**
 * Daily rollup over [start, endExclusive), split into chunks of at most
 * `maxDays` (14 for total-calories, 90 for most types), following nextPageToken.
 */
async function dailyRollUp(ctx: ApiCtx, dataType: string, start: string, endExclusive: string, maxDays: number): Promise<RollupPoint[]> {
  const lastDay = addDays(endExclusive, -1);
  const chunks = dateChunks(start, lastDay, maxDays);
  const pages = await pooled(
    chunks.map(([s, e]) => async () => {
      const out: RollupPoint[] = [];
      let pageToken: string | undefined;
      do {
        const body: Record<string, unknown> = {
          range: { start: { date: toGDate(s) }, end: { date: toGDate(addDays(e, 1)) } },
          windowSizeDays: 1,
          pageSize: maxDays,
          dataSourceFamily: DATA_SOURCE_FAMILY,
        };
        if (pageToken) body.pageToken = pageToken;
        const res = await healthApi<DailyRollUpResponse>(ctx, { method: "POST", path: `${dataPointsPath(dataType)}:dailyRollUp`, body });
        out.push(...(res.rollupDataPoints ?? []));
        pageToken = res.nextPageToken || undefined;
      } while (pageToken);
      return out;
    }),
  );
  return pages.flat();
}

const dailyFilter = (field: string, start: string, endExclusive: string) =>
  `${field}.date >= "${start}" AND ${field}.date < "${endExclusive}"`;

// --- Normalizers (pure; unit-tested against fixtures) ---

export function rollupValues(points: RollupPoint[], pick: (p: RollupPoint) => number | undefined): DailyValue[] {
  const rows: DailyValue[] = [];
  for (const p of points) {
    const value = pick(p);
    if (value !== undefined) rows.push({ date: fmtDate(p.civilStartTime.date), value });
  }
  return dedupeByDate(rows);
}

export function rollupHrZones(points: RollupPoint[]): HrZoneDay[] {
  const rows: HrZoneDay[] = [];
  for (const p of points) {
    const zones = p.timeInHeartRateZone?.timeInHeartRateZones;
    if (!zones) continue;
    rows.push({
      date: fmtDate(p.civilStartTime.date),
      zones: zones
        .filter((z) => z.heartRateZone !== "HEART_RATE_ZONE_TYPE_UNSPECIFIED")
        .map((z) => ({ name: z.heartRateZone.toLowerCase(), minutes: Math.round(durationSeconds(z.duration) / 60) })),
    });
  }
  return dedupeByDate(rows);
}

/** Map Google sleep stage types onto the Fitbit stage label values the dashboards use. */
export function stageLabel(type: string, sleepType: SleepPoint["type"]): string {
  if (type === "AWAKE") return sleepType === "CLASSIC" ? "awake" : "wake";
  return type.toLowerCase();
}

export function normalizeSleep(points: DataPoint[]): SleepNight[] {
  const nights: SleepNight[] = [];
  for (const dp of points) {
    const s = dp.sleep;
    if (!s?.interval) continue;
    const date = s.interval.civilEndTime?.date ? fmtDate(s.interval.civilEndTime.date) : s.interval.endTime.slice(0, 10);
    const minutesAsleep = num(s.summary?.minutesAsleep) ?? 0;
    const minutesInBed = Math.round((Date.parse(s.interval.endTime) - Date.parse(s.interval.startTime)) / 60000);
    const minutesAwake = num(s.summary?.minutesAwake);
    // Google Health does not expose Fitbit's efficiency score; approximate it as
    // time asleep over (asleep + awake), falling back to time in bed.
    const denom = minutesAwake !== undefined ? minutesAsleep + minutesAwake : minutesInBed;
    const stages: Record<string, number> = {};
    for (const st of s.summary?.stagesSummary ?? []) {
      if (st.type === "SLEEP_STAGE_TYPE_UNSPECIFIED") continue;
      const label = stageLabel(st.type, s.type);
      stages[label] = (stages[label] ?? 0) + (num(st.minutes) ?? 0);
    }
    nights.push({
      date,
      isMainSleep: s.metadata?.mainSleep ?? false,
      minutesAsleep,
      minutesInBed,
      efficiency: denom > 0 ? Math.round((100 * minutesAsleep) / denom) : null,
      stages,
    });
  }
  return nights.sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeRestingHr(points: DataPoint[]): DailyValue[] {
  const rows: DailyValue[] = [];
  for (const dp of points) {
    const r = dp.dailyRestingHeartRate;
    const bpm = num(r?.beatsPerMinute);
    if (r && bpm !== undefined) rows.push({ date: fmtDate(r.date), value: bpm });
  }
  return dedupeByDate(rows);
}

export function normalizeHrv(points: DataPoint[]): HrvDay[] {
  const rows: HrvDay[] = [];
  for (const dp of points) {
    const h = dp.dailyHeartRateVariability;
    if (!h) continue;
    rows.push({
      date: fmtDate(h.date),
      dailyRmssd: num(h.averageHeartRateVariabilityMilliseconds),
      deepRmssd: num(h.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
    });
  }
  return dedupeByDate(rows);
}

export function normalizeSpO2(points: DataPoint[]): SpO2Day[] {
  const rows: SpO2Day[] = [];
  for (const dp of points) {
    const o = dp.dailyOxygenSaturation;
    const avg = num(o?.averagePercentage);
    if (!o || avg === undefined) continue;
    rows.push({ date: fmtDate(o.date), avg, min: num(o.lowerBoundPercentage), max: num(o.upperBoundPercentage) });
  }
  return dedupeByDate(rows);
}

export function normalizeBreathingRate(points: DataPoint[]): DailyValue[] {
  const rows: DailyValue[] = [];
  for (const dp of points) {
    const r = dp.dailyRespiratoryRate;
    const v = num(r?.breathsPerMinute);
    if (r && v !== undefined) rows.push({ date: fmtDate(r.date), value: v });
  }
  return dedupeByDate(rows);
}

/** Nightly skin temperature relative to the 30-day baseline (what Fitbit called nightlyRelative). */
export function normalizeSkinTemp(points: DataPoint[]): DailyValue[] {
  const rows: DailyValue[] = [];
  for (const dp of points) {
    const t = dp.dailySleepTemperatureDerivations;
    const nightly = num(t?.nightlyTemperatureCelsius);
    const baseline = num(t?.baselineTemperatureCelsius);
    if (t && nightly !== undefined && baseline !== undefined) {
      rows.push({ date: fmtDate(t.date), value: Math.round((nightly - baseline) * 1000) / 1000 });
    }
  }
  return dedupeByDate(rows);
}

// --- Fetchers: [start, end] inclusive dates, as produced by dateRange() ---

type Fetcher<T> = (ctx: ApiCtx, start: string, end: string) => Promise<T>;

export const fetchSleep: Fetcher<SleepNight[]> = async (ctx, start, end) => {
  const filter = `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${addDays(end, 1)}"`;
  // Sleep: max page size 25, and dataSourceFamily is not supported.
  return normalizeSleep(await listAll(ctx, "sleep", filter, 25));
};

function dailyList<T>(dataType: string, field: string, normalize: (p: DataPoint[]) => T): Fetcher<T> {
  return async (ctx, start, end) =>
    normalize(await listAll(ctx, dataType, dailyFilter(field, start, addDays(end, 1)), 1000, DATA_SOURCE_FAMILY));
}

export const fetchRestingHeartRate = dailyList("daily-resting-heart-rate", "daily_resting_heart_rate", normalizeRestingHr);
export const fetchHrv = dailyList("daily-heart-rate-variability", "daily_heart_rate_variability", normalizeHrv);
export const fetchSpO2 = dailyList("daily-oxygen-saturation", "daily_oxygen_saturation", normalizeSpO2);
export const fetchBreathingRate = dailyList("daily-respiratory-rate", "daily_respiratory_rate", normalizeBreathingRate);
export const fetchSkinTemp = dailyList("daily-sleep-temperature-derivations", "daily_sleep_temperature_derivations", normalizeSkinTemp);

function rollup<T>(dataType: string, maxDays: number, normalize: (p: RollupPoint[]) => T): Fetcher<T> {
  return async (ctx, start, end) => normalize(await dailyRollUp(ctx, dataType, start, addDays(end, 1), maxDays));
}

export const fetchSteps = rollup("steps", 90, (p) => rollupValues(p, (r) => num(r.steps?.countSum)));
export const fetchFloors = rollup("floors", 90, (p) => rollupValues(p, (r) => num(r.floors?.countSum)));
export const fetchDistanceKm = rollup("distance", 90, (p) =>
  rollupValues(p, (r) => {
    const mm = num(r.distance?.millimetersSum);
    return mm === undefined ? undefined : mm / 1e6;
  }),
);
export const fetchCalories = rollup("total-calories", 14, (p) =>
  rollupValues(p, (r) => {
    const kcal = num(r.totalCalories?.kcalSum);
    return kcal === undefined ? undefined : Math.round(kcal);
  }),
);
export const fetchHrZones = rollup("time-in-heart-rate-zone", 90, rollupHrZones);
