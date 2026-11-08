import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeSleep,
  normalizeRestingHr,
  normalizeHrv,
  normalizeSpO2,
  normalizeSkinTemp,
  normalizeBreathingRate,
  rollupValues,
  rollupHrZones,
  durationSeconds,
  describeApiError,
  fetchSteps,
  fetchSleep,
  fetchCalories,
  type DataPoint,
  type RollupPoint,
  type ApiCtx,
} from "../src/health";
import { formatPrometheus, type MetricsData } from "../src/prom";

const d = (year: number, month: number, day: number) => ({ year, month, day });

const sleepPoint: DataPoint = {
  sleep: {
    type: "STAGES",
    interval: {
      startTime: "2026-11-07T04:30:00Z",
      endTime: "2026-11-07T12:30:00Z",
      civilStartTime: { date: d(2026, 11, 6) },
      civilEndTime: { date: d(2026, 11, 7) },
    },
    metadata: { mainSleep: true },
    summary: {
      minutesAsleep: "420",
      minutesAwake: "60",
      minutesInSleepPeriod: "480",
      stagesSummary: [
        { type: "AWAKE", minutes: "60", count: "20" },
        { type: "LIGHT", minutes: "240", count: "30" },
        { type: "DEEP", minutes: "90", count: "5" },
        { type: "REM", minutes: "90", count: "6" },
      ],
    },
  },
};

describe("normalizers", () => {
  it("maps sleep sessions onto Fitbit-style nights and stage labels", () => {
    const [n] = normalizeSleep([sleepPoint]);
    expect(n).toEqual({
      date: "2026-11-07",
      isMainSleep: true,
      minutesAsleep: 420,
      minutesInBed: 480,
      efficiency: 88,
      stages: { wake: 60, light: 240, deep: 90, rem: 90 },
    });
  });

  it("labels classic-sleep awake time as 'awake'", () => {
    const classic: DataPoint = {
      sleep: {
        ...sleepPoint.sleep!,
        type: "CLASSIC",
        summary: {
          minutesAsleep: "30",
          stagesSummary: [
            { type: "AWAKE", minutes: "5" },
            { type: "ASLEEP", minutes: "30" },
          ],
        },
      },
    };
    expect(normalizeSleep([classic])[0].stages).toEqual({ awake: 5, asleep: 30 });
  });

  it("parses daily summaries, zero-pads dates, sorts and dedupes by date", () => {
    const rhr = normalizeRestingHr([
      { dailyRestingHeartRate: { date: d(2026, 11, 7), beatsPerMinute: "58" } },
      { dailyRestingHeartRate: { date: d(2026, 11, 7), beatsPerMinute: "99" } },
      { dailyRestingHeartRate: { date: d(2026, 1, 2), beatsPerMinute: "60" } },
    ]);
    expect(rhr).toEqual([
      { date: "2026-01-02", value: 60 },
      { date: "2026-11-07", value: 58 },
    ]);
  });

  it("keeps HRV rows with only one of the two RMSSD values", () => {
    expect(normalizeHrv([{ dailyHeartRateVariability: { date: d(2026, 11, 7), averageHeartRateVariabilityMilliseconds: 41.5 } }])).toEqual([
      { date: "2026-11-07", dailyRmssd: 41.5, deepRmssd: undefined },
    ]);
  });

  it("maps SpO2, breathing rate and relative skin temperature", () => {
    expect(
      normalizeSpO2([
        { dailyOxygenSaturation: { date: d(2026, 11, 7), averagePercentage: 95.4, lowerBoundPercentage: 91, upperBoundPercentage: 99 } },
      ]),
    ).toEqual([{ date: "2026-11-07", avg: 95.4, min: 91, max: 99 }]);
    expect(normalizeBreathingRate([{ dailyRespiratoryRate: { date: d(2026, 11, 7), breathsPerMinute: 14.2 } }])).toEqual([
      { date: "2026-11-07", value: 14.2 },
    ]);
    expect(
      normalizeSkinTemp([
        { dailySleepTemperatureDerivations: { date: d(2026, 11, 7), nightlyTemperatureCelsius: 34.1, baselineTemperatureCelsius: 34.4 } },
        { dailySleepTemperatureDerivations: { date: d(2026, 11, 8), nightlyTemperatureCelsius: 34.1 } },
      ]),
    ).toEqual([{ date: "2026-11-07", value: -0.3 }]);
  });

  it("reads rollup values and heart-rate zone durations", () => {
    const points: RollupPoint[] = [
      {
        civilStartTime: { date: d(2026, 11, 7) },
        steps: { countSum: "10234" },
        timeInHeartRateZone: {
          timeInHeartRateZones: [
            { heartRateZone: "LIGHT", duration: "3600s" },
            { heartRateZone: "PEAK", duration: "90s" },
          ],
        },
      },
      { civilStartTime: { date: d(2026, 11, 8) } },
    ];
    expect(rollupValues(points, (p) => (p.steps?.countSum ? Number(p.steps.countSum) : undefined))).toEqual([
      { date: "2026-11-07", value: 10234 },
    ]);
    expect(rollupHrZones(points)).toEqual([
      {
        date: "2026-11-07",
        zones: [
          { name: "light", minutes: 60 },
          { name: "peak", minutes: 2 },
        ],
      },
    ]);
    expect(durationSeconds("12.5s")).toBe(12.5);
    expect(durationSeconds(undefined)).toBe(0);
  });

  it("explains ACCOUNT_NOT_LINKED", () => {
    const body = JSON.stringify({ error: { code: 400, status: "FAILED_PRECONDITION", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } });
    expect(describeApiError(400, body)).toContain("account not linked");
  });
});

describe("formatPrometheus", () => {
  it("keeps the fitbit_* metric names and labels", () => {
    const data: MetricsData = {
      sleep: normalizeSleep([sleepPoint]),
      restingHeartRate: [{ date: "2026-11-07", value: 58 }],
      hrZones: [{ date: "2026-11-07", zones: [{ name: "light", minutes: 60 }] }],
      hrv: [{ date: "2026-11-07", dailyRmssd: 41.5 }],
      skinTemp: [{ date: "2026-11-07", value: -0.3 }],
      spo2: [{ date: "2026-11-07", avg: 95.4, min: 91, max: 99 }],
      breathingRate: [{ date: "2026-11-07", value: 14.2 }],
      steps: [{ date: "2026-11-07", value: 10234 }],
      calories: [{ date: "2026-11-07", value: 2450 }],
      distanceKm: [{ date: "2026-11-07", value: 7.654321 }],
      floors: [{ date: "2026-11-07", value: 12 }],
    };
    const out = formatPrometheus(data);
    expect(out).toContain('fitbit_sleep_hours_asleep{date="2026-11-07"} 7.00');
    expect(out).toContain('fitbit_sleep_hours_in_bed{date="2026-11-07"} 8.00');
    expect(out).toContain('fitbit_sleep_efficiency{date="2026-11-07"} 88');
    expect(out).toContain('fitbit_sleep_stage_minutes{date="2026-11-07",stage="deep"} 90');
    expect(out).toContain('fitbit_sleep_stage_minutes{date="2026-11-07",stage="wake"} 60');
    expect(out).toContain('fitbit_resting_heart_rate{date="2026-11-07"} 58');
    expect(out).toContain('fitbit_heart_rate_zone_minutes{date="2026-11-07",zone="light"} 60');
    expect(out).toContain('fitbit_hrv_daily_rmssd{date="2026-11-07"} 41.500');
    expect(out).not.toContain("fitbit_hrv_deep_rmssd{");
    expect(out).toContain('fitbit_skin_temp_nightly_relative{date="2026-11-07"} -0.3');
    expect(out).toContain('fitbit_spo2_avg{date="2026-11-07"} 95.4');
    expect(out).toContain('fitbit_spo2_min{date="2026-11-07"} 91');
    expect(out).toContain('fitbit_spo2_max{date="2026-11-07"} 99');
    expect(out).toContain('fitbit_breathing_rate{date="2026-11-07"} 14.2');
    expect(out).toContain('fitbit_steps{date="2026-11-07"} 10234');
    expect(out).toContain('fitbit_calories{date="2026-11-07"} 2450');
    expect(out).toContain('fitbit_distance{date="2026-11-07"} 7.654');
    expect(out).toContain('fitbit_distance_mi{date="2026-11-07"} 4.76');
    expect(out).toContain('fitbit_floors{date="2026-11-07"} 12');
  });
});

describe("API requests", () => {
  afterEach(() => vi.restoreAllMocks());

  const ctx = (): ApiCtx => ({ kv: env.FITBIT_KV, userId: crypto.randomUUID(), accessToken: "at", cacheTtl: 60 });
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  it("posts a daily rollup with an exclusive end date and follows pagination", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body));
      return body.pageToken
        ? json({ rollupDataPoints: [{ civilStartTime: { date: d(2026, 11, 2) }, steps: { countSum: "200" } }] })
        : json({ rollupDataPoints: [{ civilStartTime: { date: d(2026, 11, 1) }, steps: { countSum: "100" } }], nextPageToken: "p2" });
    });

    const rows = await fetchSteps(ctx(), "2026-11-01", "2026-11-02");
    expect(rows).toEqual([
      { date: "2026-11-01", value: 100 },
      { date: "2026-11-02", value: 200 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.range).toEqual({ start: { date: d(2026, 11, 1) }, end: { date: d(2026, 11, 3) } });
    expect(body.windowSizeDays).toBe(1);
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer at");
  });

  it("splits total-calories into 14-day chunks", async () => {
    const ranges: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      ranges.push(JSON.parse(String(init?.body)).range);
      return json({ rollupDataPoints: [] });
    });
    await fetchCalories(ctx(), "2026-10-01", "2026-10-31");
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual({ start: { date: d(2026, 10, 1) }, end: { date: d(2026, 10, 15) } });
    expect(ranges[2]).toEqual({ start: { date: d(2026, 10, 29) }, end: { date: d(2026, 11, 1) } });
  });

  it("lists sleep by civil end time without a data source family", async () => {
    let url = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      url = String(input);
      return json({ dataPoints: [sleepPoint] });
    });
    const nights = await fetchSleep(ctx(), "2026-11-01", "2026-11-07");
    expect(nights).toHaveLength(1);
    const u = new URL(url);
    expect(u.pathname).toBe("/v4/users/me/dataTypes/sleep/dataPoints");
    expect(u.searchParams.get("filter")).toBe(
      'sleep.interval.civil_end_time >= "2026-11-01" AND sleep.interval.civil_end_time < "2026-11-08"',
    );
    expect(u.searchParams.get("pageSize")).toBe("25");
    expect(u.searchParams.has("dataSourceFamily")).toBe(false);
  });

  it("retries a 429 and surfaces API errors", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(json({ rollupDataPoints: [] }));
    await fetchSteps(ctx(), "2026-11-01", "2026-11-01");
    expect(spy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "nope" } }), { status: 403 }),
    );
    await expect(fetchSteps(ctx(), "2026-11-01", "2026-11-01")).rejects.toThrow("403 PERMISSION_DENIED: nope");
  });
});
