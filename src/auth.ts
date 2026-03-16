import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./consts";

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    crypto.subtle.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

export function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}

export const requireAuth: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const expected = c.env.METRICS_AUTH_TOKEN;

  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (checkToken(bearerToken, expected) || checkToken(queryToken, expected)) {
    await next();
  } else {
    return c.text("Unauthorized\n", 401);
  }
};
