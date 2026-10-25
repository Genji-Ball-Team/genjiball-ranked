// The API reads a page shows first, asked by the head script (head.ts) while the page's module is
// still loading, rather than once it runs. `api()` (lib/api.ts) takes the answer for the same path;
// a path no page asks for (the region changed once /api/server answered) is only a wasted read.

/** The paths, as the page's `api()` calls write them, that this page asks for first. */
export function earlyPaths(pathname: string, search: string, region: string): string[] {
  const query = new URLSearchParams(search);
  const r = `region=${encodeURIComponent(region)}`;
  const id = encodeURIComponent(query.get("id") ?? "");
  const page = Math.max(1, Number(query.get("page")) || 1);
  const name = pathname.replace(/\.html$/, "").replace(/^\/(index)?$/, "/leaderboard");
  const lobbies = `lobbies?${r}`;
  switch (name) {
    case "/leaderboard":
      return [`leaderboard?${r}&page=${page}${query.get("active") === "1" ? "&active=1" : ""}`, `titles?${r}`, lobbies];
    case "/player":
      return id ? [`players/${id}?${r}`, `players/${id}/history?${r}`, `titles?${r}`, lobbies] : [lobbies];
    case "/match":
      return id ? [`matches/${id}`, lobbies] : [lobbies];
    case "/matches":
      return [`recent?${r}`, lobbies];
    case "/records":
      return [`records?${r}`, lobbies];
    case "/tourneys":
      return [`tourneys?${r}&page=${page}`, lobbies];
    case "/tourney":
      return id ? [`tourneys/${id}`, lobbies] : [lobbies];
    case "/ranked":
      return ["rules", lobbies];
    case "/live":
      return [lobbies];
    default:
      return [lobbies];
  }
}

/** Asks for each path now; each answer is there for `api()` to take once. */
export function askEarly(paths: string[]): Map<string, Promise<Response>> {
  return new Map(paths.map((path) => [path, fetch(`/api/${path}`)]));
}
