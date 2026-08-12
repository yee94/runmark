import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

/** Dashboard 会话 Cookie 名 */
export const SESSION_COOKIE = "at_session";

const SESSION_SALT = "agent-tracker-dashboard-v1";

/** 7 天 */
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

export function createSessionToken(apiKey: string): string {
  return createHmac("sha256", apiKey).update(SESSION_SALT).digest("base64url");
}

export function verifySessionToken(token: string, validKeys: Set<string>): boolean {
  for (const key of validKeys) {
    const expected = createSessionToken(key);
    try {
      if (
        token.length === expected.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        return true;
      }
    } catch {
      // length mismatch
    }
  }
  return false;
}

export function extractApiKey(c: Context): string | null {
  const header =
    c.req.header("X-API-Key") ??
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  return header || null;
}

export function isRequestAuthenticated(
  c: Context,
  validKeys: Set<string>,
  publicDashboard: boolean,
): boolean {
  if (publicDashboard) return true;

  const apiKey = extractApiKey(c);
  if (apiKey && validKeys.has(apiKey)) return true;

  const session = getCookie(c, SESSION_COOKIE);
  if (session && verifySessionToken(session, validKeys)) return true;

  return false;
}

export function setSessionCookie(c: Context, apiKey: string): void {
  setCookie(c, SESSION_COOKIE, createSessionToken(apiKey), {
    httpOnly: true,
    secure: c.req.header("x-forwarded-proto") === "https",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function findMatchingApiKey(password: string, validKeys: Set<string>): string | null {
  for (const key of validKeys) {
    try {
      if (
        password.length === key.length &&
        timingSafeEqual(Buffer.from(password), Buffer.from(key))
      ) {
        return key;
      }
    } catch {
      // length mismatch
    }
  }
  return null;
}
