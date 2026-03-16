import { type Bindings, KV_REFRESH_TOKEN_KEY, FITBIT_TOKEN_URL } from "./consts";

export async function getAccessToken(env: Bindings): Promise<string> {
  const refreshToken = await env.FITBIT_KV.get(KV_REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error("No refresh token in KV. Authorize via /authorize first.");
  }

  const basicAuth = btoa(`${env.FITBIT_CLIENT_ID}:${env.FITBIT_CLIENT_SECRET}`);

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fitbit token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };

  await env.FITBIT_KV.put(KV_REFRESH_TOKEN_KEY, data.refresh_token);
  return data.access_token;
}

export async function exchangeAuthCode(env: Bindings, code: string, redirectUri: string): Promise<void> {
  const basicAuth = btoa(`${env.FITBIT_CLIENT_ID}:${env.FITBIT_CLIENT_SECRET}`);

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };

  await env.FITBIT_KV.put(KV_REFRESH_TOKEN_KEY, data.refresh_token);
}
