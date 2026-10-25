// What the admin views share: the token, the regions, the hash route, and hooks the page sets so the
// views can redraw or sign out without importing the page.
import { site } from "../lib/site";
import type { Host } from "./types";

const storage = {
  get(): string | null {
    try {
      return sessionStorage.getItem("adminToken");
    } catch {
      return null;
    }
  },
  set(value: string | null): void {
    try {
      if (value) sessionStorage.setItem("adminToken", value);
      else sessionStorage.removeItem("adminToken");
    } catch {
      // not kept
    }
  },
};

export const app = {
  /** The admin token, kept in this tab's sessionStorage only. */
  token: storage.get(),
  regions: [] as { id: string; label: string }[],
  hostCache: null as Promise<Host[]> | null,
  /** Draws the current view again (set by the page). */
  refresh: (() => Promise.resolve()) as (options?: { top?: boolean }) => Promise<void>,
  /** Forgets the token and shows the sign-in (set by the page). */
  signOut: (() => undefined) as (message?: string | null) => void,
};

export const keepToken = (value: string | null): void => storage.set(value);

export const regionLabel = (id: string | null | undefined): string =>
  app.regions.find((r) => r.id === id)?.label ?? id ?? "none";
export const regionOptions = (first?: [string, string]): [string, string][] => [
  ...(first ? [first] : []),
  ...app.regions.map((r): [string, string] => [r.id, r.label]),
];

// ---- Routing ----

export function currentRoute(): { path: string; query: URLSearchParams } {
  const [path = "", query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { path: path.replace(/\/$/, ""), query: new URLSearchParams(query) };
}

/** Changes the hash's query (filters) without drawing the view again. */
export function setQuery(values: Record<string, string>): void {
  const { path, query } = currentRoute();
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
    else query.delete(key);
  }
  const q = query.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}#/${path}${q ? `?${q}` : ""}`);
}

/** The region filter's default: the header's region. */
export const headerRegion = (): string => site.region;

// ---- The API ----

export class ApiError extends Error {}

export async function api<T = Record<string, never>>(
  path: string,
  { method = "GET", body, raw }: { method?: string; body?: unknown; raw?: Blob } = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${app.token}` };
  if (raw) headers["Content-Type"] = raw.type || "application/octet-stream";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (res.status === 401) {
    app.signOut(data.message || "Your token was signed out.");
    throw new ApiError(data.message || "Signed out");
  }
  if (!res.ok) throw new ApiError(data.message || `HTTP ${res.status}`);
  return data as T;
}

export const post = <T = Record<string, never>>(path: string, body: unknown = {}): Promise<T> =>
  api<T>(path, { method: "POST", body });

export const staleNote = (res: { ratingsStale?: boolean } | null | undefined): string =>
  res?.ratingsStale ? " Ratings are being recomputed (within 10 minutes)." : "";

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function hosts(): Promise<Host[]> {
  app.hostCache ??= api<{ hosts: Host[] }>("hosts").then((r) => r.hosts);
  const cache = app.hostCache;
  return cache.catch((e: unknown) => {
    app.hostCache = null;
    throw e;
  });
}
