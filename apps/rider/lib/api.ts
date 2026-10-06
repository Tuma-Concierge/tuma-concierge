import { createApiClient } from "@tuma/shared";

export const TOKEN_KEY = "tuma_rider_token";
export const USER_KEY = "tuma_rider_user";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

/** The session ended server-side (expired, reset, suspended, or signed out
 * elsewhere). Drop the cached copy and start again at the login screen —
 * otherwise the app keeps showing a signed-in shell where nothing loads.
 * A full page load rather than a router push, so no stale state survives. */
function onUnauthorized() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
}

export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:10000",
  getToken: getStoredToken,
  onUnauthorized,
});

/** Extracts a human-readable message from an ApiClient error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}
