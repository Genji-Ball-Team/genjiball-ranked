import type { Site } from "./lib/region";

declare global {
  interface Window {
    /** Set by the head script (head.ts), read through lib/site.ts. */
    gbSite: Site;
    /** The page's first API reads, asked by the head script (lib/early.ts), taken by `api()`. */
    gbEarly: Map<string, Promise<Response>>;
  }
}
