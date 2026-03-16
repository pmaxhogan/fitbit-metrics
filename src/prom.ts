import type {
  FitbitSleepResponse,
  FitbitHeartRateResponse,
  FitbitHrvResponse,
  FitbitTempSkinResponse,
  FitbitSpO2Response,
  FitbitBreathingRateResponse,
  FitbitStepsResponse,
  FitbitCaloriesResponse,
  FitbitDistanceResponse,
  FitbitFloorsResponse,
} from "./fitbit";

export interface MetricsData {
  sleep: FitbitSleepResponse;
  heartRate: FitbitHeartRateResponse;
  hrv: FitbitHrvResponse;
  tempSkin: FitbitTempSkinResponse;
  spo2: FitbitSpO2Response;
  br: FitbitBreathingRateResponse;
  steps: FitbitStepsResponse;
  calories: FitbitCaloriesResponse;
  distance: FitbitDistanceResponse;
  floors: FitbitFloorsResponse;
}

/** Append a Prometheus gauge metric block. */
function gauge<T>(lines: string[], name: string, help: string, entries: T[], emit: (entry: T) => string[]) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const entry of entries) {
    lines.push(...emit(entry));
  }
}

export function formatPrometheus(data: MetricsData): string {
  const {
    sleep: sleepData,
    heartRate: heartData,
    hrv: hrvData,
    tempSkin: tempSkinData,
    spo2: spo2Data,
    br: brData,
    steps: stepsData,
    calories: caloriesData,
    distance: distanceData,
    floors: floorsData,
  } = data;
  const lines: string[] = [];
  const mainSleeps = sleepData.sleep.filter((s) => s.isMainSleep);

  gauge(lines, "fitbit_sleep_hours_asleep", "Total hours asleep.", mainSleeps, (s) => [
    `fitbit_sleep_hours_asleep{date="${s.dateOfSleep}"} ${(s.minutesAsleep / 60).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_sleep_hours_in_bed", "Total hours in bed.", mainSleeps, (s) => [
    `fitbit_sleep_hours_in_bed{date="${s.dateOfSleep}"} ${(s.timeInBed / 60).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_sleep_efficiency", "Sleep efficiency score (0-100).", mainSleeps, (s) => [
    `fitbit_sleep_efficiency{date="${s.dateOfSleep}"} ${s.efficiency}`,
  ]);

  gauge(lines, "fitbit_sleep_stage_minutes", "Minutes spent in each sleep stage.", mainSleeps, (s) =>
    Object.entries(s.levels.summary).map(
      ([stage, info]) => `fitbit_sleep_stage_minutes{date="${s.dateOfSleep}",stage="${stage}"} ${info.minutes}`,
    ),
  );

  gauge(lines, "fitbit_resting_heart_rate", "Resting heart rate in bpm.", heartData["activities-heart"], (entry) =>
    entry.value.restingHeartRate != null ? [`fitbit_resting_heart_rate{date="${entry.dateTime}"} ${entry.value.restingHeartRate}`] : [],
  );

  gauge(lines, "fitbit_heart_rate_zone_minutes", "Minutes in each heart rate zone.", heartData["activities-heart"], (entry) =>
    entry.value.heartRateZones.map(
      (zone) => `fitbit_heart_rate_zone_minutes{date="${entry.dateTime}",zone="${zone.name}"} ${zone.minutes}`,
    ),
  );

  gauge(lines, "fitbit_hrv_daily_rmssd", "Daily RMSSD heart rate variability (ms).", hrvData.hrv, (entry) => [
    `fitbit_hrv_daily_rmssd{date="${entry.dateTime}"} ${entry.value.dailyRmssd.toFixed(3)}`,
  ]);

  gauge(lines, "fitbit_hrv_deep_rmssd", "Deep-sleep RMSSD heart rate variability (ms).", hrvData.hrv, (entry) => [
    `fitbit_hrv_deep_rmssd{date="${entry.dateTime}"} ${entry.value.deepRmssd.toFixed(3)}`,
  ]);

  gauge(
    lines,
    "fitbit_skin_temp_nightly_relative",
    "Nightly skin temperature deviation from baseline (C).",
    tempSkinData.tempSkin,
    (entry) => [`fitbit_skin_temp_nightly_relative{date="${entry.dateTime}"} ${entry.value.nightlyRelative}`],
  );

  gauge(lines, "fitbit_spo2_avg", "Average SpO2 percentage.", spo2Data, (entry) => [
    `fitbit_spo2_avg{date="${entry.dateTime}"} ${entry.value.avg}`,
  ]);

  gauge(lines, "fitbit_spo2_min", "Minimum SpO2 percentage.", spo2Data, (entry) => [
    `fitbit_spo2_min{date="${entry.dateTime}"} ${entry.value.min}`,
  ]);

  gauge(lines, "fitbit_spo2_max", "Maximum SpO2 percentage.", spo2Data, (entry) => [
    `fitbit_spo2_max{date="${entry.dateTime}"} ${entry.value.max}`,
  ]);

  gauge(lines, "fitbit_breathing_rate", "Breathing rate (breaths per minute).", brData.br, (entry) => [
    `fitbit_breathing_rate{date="${entry.dateTime}"} ${entry.value.breathingRate}`,
  ]);

  gauge(lines, "fitbit_steps", "Daily step count.", stepsData["activities-steps"], (entry) => [
    `fitbit_steps{date="${entry.dateTime}"} ${entry.value}`,
  ]);

  gauge(lines, "fitbit_calories", "Daily calories burned.", caloriesData["activities-calories"], (entry) => [
    `fitbit_calories{date="${entry.dateTime}"} ${entry.value}`,
  ]);

  gauge(lines, "fitbit_distance", "Daily distance traveled (km).", distanceData["activities-distance"], (entry) => [
    `fitbit_distance{date="${entry.dateTime}"} ${entry.value}`,
  ]);

  gauge(lines, "fitbit_distance_mi", "Daily distance traveled (miles).", distanceData["activities-distance"], (entry) => [
    `fitbit_distance_mi{date="${entry.dateTime}"} ${(parseFloat(entry.value) * 0.621371).toFixed(2)}`,
  ]);

  gauge(lines, "fitbit_floors", "Daily floors climbed.", floorsData["activities-floors"], (entry) => [
    `fitbit_floors{date="${entry.dateTime}"} ${entry.value}`,
  ]);

  lines.push("");
  return lines.join("\n");
}
