// Builds the website's scripts and styles from site/ into public/build/ (not in git). wrangler runs
// it before `wrangler dev` and `wrangler deploy` ([build] in wrangler.toml), so a deploy always has
// a fresh build. `--watch` rebuilds on every change.
//
// - build/head.js: the region script, a classic script in <head> so the region's colours are there
//   from the first frame.
// - build/<page>.js: one module per page (site/pages/), sharing chunks for what they have in common.
// - build/site.css: @genji-ball-team/ui's base.css and the site's own styles, with Saira's files.
//   build/admin.css and build/lost.css: the styles only the admin and the 404 page use, after it.
import { context, build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
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

if (watch) {
  for (const options of builds) await (await context(options)).watch();
  stdout.write(`Watching site/ → ${outdir}/
`);
} else {
  await Promise.all(builds.map((options) => build(options)));
}
