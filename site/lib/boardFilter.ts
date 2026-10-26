// The leaderboard's filter in the page's address (`?tier=master,none&played=7&rounds=100&min=1500&max=2000`,
// docs/api.md): the same names as `/api/leaderboard` takes. The head script asks for the board with
// `boardQuery` (early.ts) and the page with the same, so they ask for the same path.

/** The filter's parameters, in the order `boardQuery` writes them. `active` is the old Everyone / Active link's. */
export const boardParams = ["tier", "played", "rounds", "min", "max", "active"] as const;

export type BoardParam = (typeof boardParams)[number];

/** The filter part of a leaderboard query (`&tier=master&played=7`), from the page's address; "" without one. */
export function boardQuery(search: string | URLSearchParams): string {
  const query = new URLSearchParams(search);
  return boardParams
    .map((name) => [name, query.get(name) ?? ""] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `&${name}=${encodeURIComponent(value).replace(/%2C/g, ",")}`)
    .join("");
}
