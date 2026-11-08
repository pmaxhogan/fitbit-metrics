// Google OAuth 2.0 + Google Health API (successor to the Fitbit Web API, which
// was decommissioned on 2026-10-30).
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const HEALTH_API_BASE = "https://health.googleapis.com/v4";
export const HEALTH_USER = "users/me";
export const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
].join(" ");

// Data source family for rollups and daily summaries: Fitbit/Pixel trackers only,
// so phone-counted steps (Health Connect) are not mixed in. Not supported for sleep.
export const DATA_SOURCE_FAMILY = `${HEALTH_USER}/dataSourceFamilies/google-wearables`;

export const LOOKBACK_DAYS = 30;
export const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 hours (current window: recent days may still be revised)
export const HISTORICAL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (daysAgo>0 windows are in the past and immutable)
export const MAX_RETRIES = 4;
export const MAX_CONCURRENCY = 6; // Workers limit: 6 simultaneous outgoing connections
export const STATE_TTL_SECONDS = 600; // 10 minutes for OAuth state
export const ACCESS_TOKEN_SAFETY_SECONDS = 300; // refresh access tokens 5 minutes before they expire

// KV key helpers, namespaced per user
export const kvKey = {
  refreshToken: (userId: string) => `user:${userId}:refresh_token`,
  accessToken: (userId: string) => `user:${userId}:access_token`,
  cache: (userId: string, key: string) => `user:${userId}:cache:${key}`,
  cachePrefix: (userId: string) => `user:${userId}:cache:`,
  token: (token: string) => `token:${token}`, // maps token -> userId
  oauthState: (state: string) => `oauth_state:${state}`, // CSRF state -> temporary
};
