import { kvKey, GOOGLE_TOKEN_URL, ACCESS_TOKEN_SAFETY_SECONDS } from "./consts";

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  // Only returned on the authorization-code grant (with access_type=offline),
  // and not on refresh: never overwrite a stored refresh token with undefined.
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const hint = body.includes("invalid_grant") ? " Re-authorize via /authorize?token=<your API token>." : "";
    throw new Error(`Google token ${params.grant_type} failed (${res.status}): ${body}${hint}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

async function cacheAccessToken(env: Env, userId: string, data: GoogleTokenResponse): Promise<void> {
  const ttl = (data.expires_in ?? 3600) - ACCESS_TOKEN_SAFETY_SECONDS;
  // KV requires expirationTtl >= 60
  if (ttl >= 60) {
    await env.FITBIT_KV.put(kvKey.accessToken(userId), data.access_token, { expirationTtl: ttl });
  }
}

export async function getAccessToken(env: Env, userId: string): Promise<string> {
  const cached = await env.FITBIT_KV.get(kvKey.accessToken(userId));
  if (cached) return cached;

  const refreshToken = await env.FITBIT_KV.get(kvKey.refreshToken(userId));
  if (!refreshToken) {
    throw new Error("No refresh token in KV. Authorize via /authorize first.");
  }

  const data = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (data.refresh_token) {
    await env.FITBIT_KV.put(kvKey.refreshToken(userId), data.refresh_token);
  }
  await cacheAccessToken(env, userId, data);
  return data.access_token;
}

/** Exchange an authorization code; stores the refresh token and returns the access token. */
export async function exchangeAuthCode(env: Env, userId: string, code: string, redirectUri: string): Promise<string> {
  const data = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke the app's access at https://myaccount.google.com/permissions and retry.",
    );
  }
  await env.FITBIT_KV.put(kvKey.refreshToken(userId), data.refresh_token);
  await cacheAccessToken(env, userId, data);
  return data.access_token;
}
