// The built site's Content-Security-Policy (site/_headers, scripts/csp.mjs): public/_headers gives
// every file the policy, with a hash for each UI component's <style>, and nothing a built page
// carries inline is something the policy would block. `npm test` builds the site first.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { componentStyles, hashSource } from "../scripts/csp.mjs";

const headers = readFileSync("public/_headers", "utf8");
const pages = readdirSync("public").filter((file) => file.endsWith(".html"));

/** The headers of the `/*` rule. */
function everyFile() {
  const rule = /^\/\*\n((?: {2}.+\n)+)/m.exec(headers);
  assert.ok(rule, "public/_headers has a /* rule");
  return new Map(rule[1].trim().split("\n").map((line) => line.trim().split(/: (.*)/s).slice(0, 2)));
}

/** The policy's directives: name → sources. */
function policy() {
  const csp = everyFile().get("Content-Security-Policy");
  assert.ok(csp, "the /* rule sets a Content-Security-Policy");
  return new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
}

test("every file gets the security headers", () => {
  const all = everyFile();
  assert.match(all.get("Strict-Transport-Security"), /^max-age=\d{7,}/);
  assert.equal(all.get("X-Content-Type-Options"), "nosniff");
  assert.equal(all.get("X-Frame-Options"), "DENY");
  assert.equal(all.get("Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("the policy allows only the site, the analytics beacon and the host tool's releases", () => {
  const p = policy();
  assert.deepEqual(p.get("default-src"), ["'none'"]);
  assert.deepEqual(p.get("script-src"), ["'self'", "https://static.cloudflareinsights.com"]);
  assert.deepEqual(p.get("style-src-attr"), ["'unsafe-inline'"]);
  assert.deepEqual(p.get("font-src"), ["'self'"]);
  assert.deepEqual(p.get("img-src"), ["'self'", "blob:"]);
  assert.deepEqual(p.get("connect-src"), ["'self'", "https://api.github.com", "https://cloudflareinsights.com"]);
  assert.deepEqual(p.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(p.get("base-uri"), ["'none'"]);
  // The site is 'self' everywhere, so the test server works the same.
  assert.doesNotMatch(everyFile().get("Content-Security-Policy"), /genjiball\.us|unsafe-eval|\{/);
});

test("the policy has a hash for each UI component's <style>, and no other inline style", async () => {
  const styles = await componentStyles();
  assert.ok(styles.length > 10, "the UI's components were found");
  const elem = policy().get("style-src-elem");
  assert.deepEqual(elem, ["'self'", ...styles.map(hashSource).sort()]);
  // Shadow-root styles are made by the scripts: a page's HTML has none of its own.
  for (const page of pages) assert.doesNotMatch(readFileSync(`public/${page}`, "utf8"), /<style\b/i, page);
});

test("no built page has an inline script, an event handler attribute or a javascript: URL", () => {
  for (const page of pages) {
    const html = readFileSync(`public/${page}`, "utf8");
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
      assert.match(tag, /\ssrc="\/build\/chunks\/[\w-]+\.js"/, `${page}: ${tag} is inline or not the site's`);
    }
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, `${page} has an on…= attribute`);
    assert.doesNotMatch(html, /javascript:/i, page);
    // Stylesheets, fonts and module preloads come from the site itself ('self').
    for (const [, href] of html.matchAll(/<link\b[^>]*\brel="(?:stylesheet|preload|modulepreload)"[^>]*\bhref="([^"]+)"/gi)) {
      assert.match(href, /^\/build\//, `${page}: ${href}`);
    }
  }
});

test("the module preloads name the site's own built files", () => {
  const links = [...headers.matchAll(/<([^>]+)>; rel=modulepreload/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /^\/build\/chunks\/[\w-]+\.js$/);
});
