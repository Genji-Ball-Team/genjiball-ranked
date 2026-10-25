import type { Site } from "./lib/region";

declare global {
  interface Window {
    /** Set by the head script (head.ts), read through lib/site.ts. */
    gbSite: Site;
  }
}
