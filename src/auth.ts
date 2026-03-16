import type { MiddlewareHandler } from "hono";
import { kvKey } from "./consts";

/** Resolve a bearer token to a userId, or null if invalid. */
export async function resolveToken(kv: KVNamespace, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  return kv.get(kvKey.token(token));
}

/**
 * Middleware that requires a valid user token (bearer or ?token= query param).
 * Sets c.set("userId", ...) on success.
 */
export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: { userId: string };
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  const token = bearerToken ?? queryToken;
  const userId = await resolveToken(c.env.FITBIT_KV, token);

  if (!userId) {
    return c.text("Unauthorized!\nProvide a token via header 'Authorization: Bearer abcd1234-...', or url parameter '?token=abcd1234-...'.\nGet your token via /authorize, see README at / or API reference at /reference", 401);
  }

  c.set("userId", userId);
  await next();
};
