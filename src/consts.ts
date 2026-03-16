export const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
export const KV_REFRESH_TOKEN_KEY = "fitbit_refresh_token";
export const LOOKBACK_DAYS = 30;
export const DATE_CHUNK_LIMIT = 30;
export const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 hours
export const MAX_RETRIES = 4;
export const MAX_CONCURRENCY = 6; // Workers limit: 6 simultaneous outgoing connections


export type Bindings = {
  FITBIT_KV: KVNamespace;
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  FITBIT_INITIAL_REFRESH_TOKEN: string;
  METRICS_AUTH_TOKEN: string;
};