import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("fitbit-metrics worker", () => {
  it("responds on / with info text", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("/metrics");
  });

  it("redirects /authorize to Google with offline access and the Google Health scopes", async () => {
    const response = await SELF.fetch("https://example.com/authorize", { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
    expect(location.searchParams.get("scope")).toContain("googlehealth.sleep.readonly");
  });

  it("rejects re-linking with an unknown token", async () => {
    const response = await SELF.fetch("https://example.com/authorize?token=nope", { redirect: "manual" });
    expect(response.status).toBe(401);
  });

  it("binds the OAuth state to the initiating browser with a cookie", async () => {
    const start = await SELF.fetch("https://example.com/authorize", { redirect: "manual" });
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cookie = start.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`oauth_state=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // A valid state presented from a browser without the cookie is refused
    // (someone else's authorization link), before any code exchange.
    const hijack = await SELF.fetch(`https://example.com/callback?code=x&state=${state}`);
    expect(hijack.status).toBe(403);
    expect(await hijack.text()).toContain("does not match");
  });

  it("serves the privacy policy", async () => {
    const response = await SELF.fetch("https://example.com/privacy");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Limited Use");
  });

  it("rejects /callback with an unknown state", async () => {
    const response = await SELF.fetch("https://example.com/callback?code=x&state=unknown");
    expect(response.status).toBe(403);
  });
});
