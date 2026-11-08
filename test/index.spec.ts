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

  it("rejects /callback with an unknown state", async () => {
    const response = await SELF.fetch("https://example.com/callback?code=x&state=unknown");
    expect(response.status).toBe(403);
  });
});
