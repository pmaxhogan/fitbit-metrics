import {
  FitbitSleepResponse,
  FitbitHeartRateResponse,
  FitbitHrvResponse,
  FitbitTempSkinResponse,
  FitbitSpO2Response,
  FitbitBreathingRateResponse,
  FitbitStepsResponse,
} from "./fitbit";

export function formatPrometheus(
  sleepData: FitbitSleepResponse,
  heartData: FitbitHeartRateResponse,
  hrvData: FitbitHrvResponse,
  tempSkinData: FitbitTempSkinResponse,
  spo2Data: FitbitSpO2Response,
  brData: FitbitBreathingRateResponse,
  stepsData: FitbitStepsResponse,
): string {
  const lines: string[] = [];

  const mainSleeps = sleepData.sleep.filter((s) => s.isMainSleep);

  lines.push("# HELP fitbit_sleep_hours_asleep Total hours asleep.");
  lines.push("# TYPE fitbit_sleep_hours_asleep gauge");
  for (const s of mainSleeps) {
    lines.push(`fitbit_sleep_hours_asleep{date="${s.dateOfSleep}"} ${(s.minutesAsleep / 60).toFixed(2)}`);
  }

  lines.push("# HELP fitbit_sleep_hours_in_bed Total hours in bed.");
  lines.push("# TYPE fitbit_sleep_hours_in_bed gauge");
  for (const s of mainSleeps) {
    lines.push(`fitbit_sleep_hours_in_bed{date="${s.dateOfSleep}"} ${(s.timeInBed / 60).toFixed(2)}`);
  }

  lines.push("# HELP fitbit_sleep_efficiency Sleep efficiency score (0-100).");
  lines.push("# TYPE fitbit_sleep_efficiency gauge");
  for (const s of mainSleeps) {
    lines.push(`fitbit_sleep_efficiency{date="${s.dateOfSleep}"} ${s.efficiency}`);
  }

  lines.push("# HELP fitbit_sleep_stage_minutes Minutes spent in each sleep stage.");
  lines.push("# TYPE fitbit_sleep_stage_minutes gauge");
  for (const s of mainSleeps) {
    for (const [stage, info] of Object.entries(s.levels.summary)) {
      lines.push(`fitbit_sleep_stage_minutes{date="${s.dateOfSleep}",stage="${stage}"} ${info.minutes}`);
    }
  }

  lines.push("# HELP fitbit_resting_heart_rate Resting heart rate in bpm.");
  lines.push("# TYPE fitbit_resting_heart_rate gauge");
  for (const entry of heartData["activities-heart"]) {
    if (entry.value.restingHeartRate != null) {
      lines.push(`fitbit_resting_heart_rate{date="${entry.dateTime}"} ${entry.value.restingHeartRate}`);
    }
  }

  lines.push("# HELP fitbit_heart_rate_zone_minutes Minutes in each heart rate zone.");
  lines.push("# TYPE fitbit_heart_rate_zone_minutes gauge");
  for (const entry of heartData["activities-heart"]) {
    for (const zone of entry.value.heartRateZones) {
      lines.push(`fitbit_heart_rate_zone_minutes{date="${entry.dateTime}",zone="${zone.name}"} ${zone.minutes}`);
    }
  }

  lines.push("# HELP fitbit_hrv_daily_rmssd Daily RMSSD heart rate variability (ms).");
  lines.push("# TYPE fitbit_hrv_daily_rmssd gauge");
  for (const entry of hrvData.hrv) {
    lines.push(`fitbit_hrv_daily_rmssd{date="${entry.dateTime}"} ${entry.value.dailyRmssd.toFixed(3)}`);
  }

  lines.push("# HELP fitbit_hrv_deep_rmssd Deep-sleep RMSSD heart rate variability (ms).");
  lines.push("# TYPE fitbit_hrv_deep_rmssd gauge");
  for (const entry of hrvData.hrv) {
    lines.push(`fitbit_hrv_deep_rmssd{date="${entry.dateTime}"} ${entry.value.deepRmssd.toFixed(3)}`);
  }

  lines.push("# HELP fitbit_skin_temp_nightly_relative Nightly skin temperature deviation from baseline (C).");
  lines.push("# TYPE fitbit_skin_temp_nightly_relative gauge");
  for (const entry of tempSkinData.tempSkin) {
    lines.push(`fitbit_skin_temp_nightly_relative{date="${entry.dateTime}"} ${entry.value.nightlyRelative}`);
  }

  lines.push("# HELP fitbit_spo2_avg Average SpO2 percentage.");
  lines.push("# TYPE fitbit_spo2_avg gauge");
  for (const entry of spo2Data) {
    lines.push(`fitbit_spo2_avg{date="${entry.dateTime}"} ${entry.value.avg}`);
  }

  lines.push("# HELP fitbit_spo2_min Minimum SpO2 percentage.");
  lines.push("# TYPE fitbit_spo2_min gauge");
  for (const entry of spo2Data) {
    lines.push(`fitbit_spo2_min{date="${entry.dateTime}"} ${entry.value.min}`);
  }

  lines.push("# HELP fitbit_spo2_max Maximum SpO2 percentage.");
  lines.push("# TYPE fitbit_spo2_max gauge");
  for (const entry of spo2Data) {
    lines.push(`fitbit_spo2_max{date="${entry.dateTime}"} ${entry.value.max}`);
  }

  lines.push("# HELP fitbit_breathing_rate Breathing rate (breaths per minute).");
  lines.push("# TYPE fitbit_breathing_rate gauge");
  for (const entry of brData.br) {
    lines.push(`fitbit_breathing_rate{date="${entry.dateTime}"} ${entry.value.breathingRate}`);
  }

  lines.push("# HELP fitbit_steps Daily step count.");
  lines.push("# TYPE fitbit_steps gauge");
  for (const entry of stepsData["activities-steps"]) {
    lines.push(`fitbit_steps{date="${entry.dateTime}"} ${entry.value}`);
  }

  lines.push("");
  return lines.join("\n");
}
