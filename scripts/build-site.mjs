// Builds the website's scripts and styles from site/ into public/build/ (not in git). wrangler runs
// it before `wrangler dev` and `wrangler deploy` ([build] in wrangler.toml), so a deploy always has
// a fresh build. `--watch` rebuilds on every change.
//
// - build/head.js: the region script, a classic script in <head> so the region's colours are there
//   from the first frame.
// - build/<page>.js: one module per page (site/pages/), sharing chunks for what they have in common.
// - build/site.css: @genji-ball-team/ui's base.css and the site's own styles, with Saira's files.
//   build/admin.css and build/lost.css: the styles only the admin and the 404 page use, after it.
// - _headers: site/_headers, plus a `Link: rel=modulepreload` for each page's chunks, so the browser
//   fetches them with the page instead of after its module (not in git: the chunk names change).
import { context, build } from "esbuild";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { argv, stdout } from "node:process";

const outdir = "public/build";
const watch = argv.includes("--watch");
rmSync(outdir, { recursive: true, force: true });

const pages = readdirSync("site/pages")
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `site/pages/${file}`);

const shared = {
  bundle: true,
  minify: !watch,
  sourcemap: true,
  target: "es2022",
  logLevel: "warning",
  legalComments: "none",
};

const builds = [
  { ...shared, entryPoints: { head: "site/head.ts" }, outdir, format: "iife" },
  {
    ...shared,
    entryPoints: pages,
    outdir,
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    metafile: true,
  },
  {
    ...shared,
    entryPoints: { site: "site/style/site.css", admin: "site/style/admin.css", lost: "site/style/lost.css" },
    outdir,
    loader: { ".woff2": "file" },
    // No hash, so the pages can preload Saira by name.
    assetNames: "fonts/[name]",
  },
];

/** The page each module is for: the leaderboard is `/`, the 404 page has no path of its own. */
const pagePath = (name) => (name === "leaderboard" ? "/" : name === "lost" ? null : `/${name}`);

/** public/_headers: site/_headers, then each page's module and the chunks it imports. */
function writeHeaders(metafile) {
  let text = readFileSync("site/_headers", "utf8");
  for (const [file, output] of Object.entries(metafile?.outputs ?? {})) {
    const path = output.entryPoint && pagePath(file.split("/").pop().replace(/\.js$/, ""));
    if (!path) continue;
    const modules = [file, ...output.imports.filter((i) => i.kind === "import-statement").map((i) => i.path)];
    const links = modules.map((m) => `</${m.replace(/^public\//, "")}>; rel=modulepreload`).join(", ");
    text += `
${path}
  Link: ${links}
`;
  }
  writeFileSync("public/_headers", text);
}

if (watch) {
  writeHeaders(null);
  for (const options of builds) await (await context(options)).watch();
  stdout.write(`Watching site/ → ${outdir}/
`);
} else {
  const [, pagesBuilt] = await Promise.all(builds.map((options) => build(options)));
  writeHeaders(pagesBuilt.metafile);
}
