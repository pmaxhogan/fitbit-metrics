import type { DailyValue, SleepNight, HrZoneDay, HrvDay, SpO2Day } from "./health";

// Metric and label names are unchanged from the Fitbit Web API era (fitbit_*),
// so existing dashboards and stored history keep working.
export interface MetricsData {
  sleep: SleepNight[];
  restingHeartRate: DailyValue[];
  hrZones: HrZoneDay[];
  hrv: HrvDay[];
  skinTemp: DailyValue[];
  spo2: SpO2Day[];
  breathingRate: DailyValue[];
  steps: DailyValue[];
  calories: DailyValue[];
  distanceKm: DailyValue[];
  floors: DailyValue[];
}

/** Append a Prometheus gauge metric block. */
function gauge<T>(lines: string[], name: string, help: string, entries: T[], emit: (entry: T) => string[]) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const entry of entries) {
    lines.push(...emit(entry));
  }
}

const fixed = (v: number, digits: number) => String(Number(v.toFixed(digits)));

export function formatPrometheus(data: MetricsData): string {
  const lines: string[] = [];
  const mainSleeps = data.sleep.filter((s) => s.isMainSleep);

  gauge(lines, "fitbit_sleep_hours_asleep", "Total hours asleep.", mainSleeps, (s) => [
    `fitbit_sleep_hours_asleep{date="${s.date}"} ${(s.minutesAsleep / 60).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_sleep_hours_in_bed", "Total hours in bed.", mainSleeps, (s) => [
    `fitbit_sleep_hours_in_bed{date="${s.date}"} ${(s.minutesInBed / 60).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_sleep_efficiency", "Sleep efficiency (0-100), asleep / (asleep + awake).", mainSleeps, (s) =>
    s.efficiency !== null ? [`fitbit_sleep_efficiency{date="${s.date}"} ${s.efficiency}`] : [],
  );

  gauge(lines, "fitbit_sleep_stage_minutes", "Minutes spent in each sleep stage.", mainSleeps, (s) =>
    Object.entries(s.stages).map(([stage, minutes]) => `fitbit_sleep_stage_minutes{date="${s.date}",stage="${stage}"} ${minutes}`),
  );

  gauge(lines, "fitbit_resting_heart_rate", "Resting heart rate in bpm.", data.restingHeartRate, (e) => [
    `fitbit_resting_heart_rate{date="${e.date}"} ${e.value}`,
  ]);

  gauge(lines, "fitbit_heart_rate_zone_minutes", "Minutes in each heart rate zone.", data.hrZones, (e) =>
    e.zones.map((z) => `fitbit_heart_rate_zone_minutes{date="${e.date}",zone="${z.name}"} ${z.minutes}`),
  );

  gauge(lines, "fitbit_hrv_daily_rmssd", "Daily RMSSD heart rate variability (ms).", data.hrv, (e) =>
    e.dailyRmssd !== undefined ? [`fitbit_hrv_daily_rmssd{date="${e.date}"} ${e.dailyRmssd.toFixed(3)}`] : [],
  );

  gauge(lines, "fitbit_hrv_deep_rmssd", "Deep-sleep RMSSD heart rate variability (ms).", data.hrv, (e) =>
    e.deepRmssd !== undefined ? [`fitbit_hrv_deep_rmssd{date="${e.date}"} ${e.deepRmssd.toFixed(3)}`] : [],
  );

  gauge(lines, "fitbit_skin_temp_nightly_relative", "Nightly skin temperature deviation from baseline (C).", data.skinTemp, (e) => [
    `fitbit_skin_temp_nightly_relative{date="${e.date}"} ${e.value}`,
  ]);

  gauge(lines, "fitbit_spo2_avg", "Average SpO2 percentage during sleep.", data.spo2, (e) => [
    `fitbit_spo2_avg{date="${e.date}"} ${e.avg}`,
  ]);

  gauge(lines, "fitbit_spo2_min", "Lower bound of SpO2 percentage during sleep.", data.spo2, (e) =>
    e.min !== undefined ? [`fitbit_spo2_min{date="${e.date}"} ${e.min}`] : [],
  );

  gauge(lines, "fitbit_spo2_max", "Upper bound of SpO2 percentage during sleep.", data.spo2, (e) =>
    e.max !== undefined ? [`fitbit_spo2_max{date="${e.date}"} ${e.max}`] : [],
  );

  gauge(lines, "fitbit_breathing_rate", "Breathing rate (breaths per minute).", data.breathingRate, (e) => [
    `fitbit_breathing_rate{date="${e.date}"} ${e.value}`,
  ]);

  gauge(lines, "fitbit_steps", "Daily step count.", data.steps, (e) => [`fitbit_steps{date="${e.date}"} ${e.value}`]);

  gauge(lines, "fitbit_calories", "Daily calories burned.", data.calories, (e) => [`fitbit_calories{date="${e.date}"} ${e.value}`]);

  gauge(lines, "fitbit_distance", "Daily distance traveled (km).", data.distanceKm, (e) => [
    `fitbit_distance{date="${e.date}"} ${fixed(e.value, 3)}`,
  ]);

  gauge(lines, "fitbit_distance_mi", "Daily distance traveled (miles).", data.distanceKm, (e) => [
    `fitbit_distance_mi{date="${e.date}"} ${(e.value * 0.621371).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_floors", "Daily floors climbed.", data.floors, (e) => [`fitbit_floors{date="${e.date}"} ${e.value}`]);

  lines.push("");
  return lines.join("\n");
}
