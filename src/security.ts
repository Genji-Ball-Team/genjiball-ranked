/**
 * Security headers on every answer the Worker gives. A page (a file in public/, also when the
 * Worker hands it on: the 404 page, a link preview) has them from site/_headers, with the site's
 * Content-Security-Policy, and keeps them. Everything else the Worker builds itself (the API's JSON,
 * a screenshot, robots.txt) is never a page to run anything in, so its policy allows nothing.
 */
const apiPolicy = "default-src 'none'; frame-ancestors 'none'";

const always: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export function withSecurityHeaders(response: Response): Response {
  // A WebSocket upgrade can't be rebuilt; the Worker doesn't serve one, but it shouldn't break one.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(always)) headers.set(name, value);
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", apiPolicy);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
