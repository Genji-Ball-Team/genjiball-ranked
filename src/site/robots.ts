// robots.txt and sitemap.xml, for search engines. The test server asks them to stay away, so its fake
// ratings never show up in a search; the real site lists its pages in every region.
import type { Config } from "../config";

/** The pages worth finding in a search, as the site links them: the home page first. */
const sitemapPages = ["/", "/matches", "/records", "/live", "/tourneys", "/ranked", "/host", "/data"];

/** Kept a day at the edge and in the browser: the answers only change with a deploy. */
const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "public, max-age=86400" });

export function robotsTxt(config: Pick<Config, "testServer">, origin: string): Response {
  const body = config.testServer
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nDisallow: /admin\n\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, { headers: headers("text/plain; charset=utf-8") });
}

/** Every page in `sitemapPages`, once per region. None on the test server. */
export function sitemapXml(config: Pick<Config, "testServer" | "regions">, origin: string): Response {
  if (config.testServer) return new Response(null, { status: 404 });
  const urls = config.regions.flatMap((region) =>
    sitemapPages.map((page) => `  <url><loc>${origin}${page}?region=${region.id}</loc></url>`),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: headers("application/xml; charset=utf-8") });
}
