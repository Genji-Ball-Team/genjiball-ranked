// The region state the head script made (head.ts). Page modules run after it, so it's always there.
import type { Site } from "./region";

export const site: Site = window.gbSite;
