export const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
export const LOOKBACK_DAYS = 30;
export const DATE_CHUNK_LIMIT = 30;
export const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 hours (current window: recent days may still be revised by Fitbit)
export const HISTORICAL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (daysAgo>0 windows are in the past and immutable)
export const MAX_RETRIES = 4;
export const MAX_CONCURRENCY = 6; // Workers limit: 6 simultaneous outgoing connections
export const STATE_TTL_SECONDS = 600; // 10 minutes for OAuth state
export const SCOPES = "sleep heartrate temperature oxygen_saturation respiratory_rate activity";

// KV key helpers, namespaced per user
export const kvKey = {
  refreshToken: (userId: string) => `user:${userId}:refresh_token`,
  cache: (userId: string, path: string) => `user:${userId}:cache:${path}`,
  token: (token: string) => `token:${token}`, // maps token -> userId
  oauthState: (state: string) => `oauth_state:${state}`, // CSRF state -> temporary
};
