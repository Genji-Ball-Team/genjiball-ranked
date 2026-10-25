// Reading the public API (docs/api.md, "Site"). Answers are cached by the browser for a minute.
import { site } from "./site";

/** The API's 404: no such player, match or tourney (or one that isn't public). */
export class NotFound extends Error {
  constructor() {
    super("not_found");
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, init);
  if (res.status === 404) throw new NotFound();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** `region=eu`, for a query string: this page's region unless another is given. */
export const inRegion = (region = site.region): string => `region=${encodeURIComponent(region)}`;

/** A player's page in this page's region: their rating there, also when the link is shared. */
export const playerLink = (id: number, region = site.region): string => `/player?id=${id}&${inRegion(region)}`;

export const matchLink = (id: number): string => `/match?id=${id}`;

/** The `?id=` of a player, match or tourney page. */
export const idParam = (): string => new URLSearchParams(location.search).get("id") ?? "";
