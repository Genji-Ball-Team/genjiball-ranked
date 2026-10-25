// Builds the website from site/ into public/ (none of it in git). wrangler runs it before
// `wrangler dev` and `wrangler deploy` ([build] in wrangler.toml), so a deploy always has a fresh
// build. `--watch` rebuilds the scripts and styles on every change.
//
// - build/head.js: the region script, a classic script in <head> so the region's colours are there
//   from the first frame.
// - build/<page>.js: one module per page (site/pages/), sharing chunks for what they have in common.
// - build/site.css: @genji-ball-team/ui's base.css and the site's own styles, with Saira's files.
//   build/admin.css and build/lost.css: the styles only the admin and the 404 page use, after it.
// - <page>.html: site/html/'s, with each `/build/<name>.js` or `.css` it names pointing at the built
//   file. Every built script and style is `build/chunks/<name>-<hash>`, so the browser keeps it for
//   good (site/_headers) and a changed one is a new file. `--watch` keeps the plain names.
// - _headers: site/_headers, plus a `Link: rel=modulepreload` for each page's chunks, so the browser
//   fetches them with the page instead of after its module.
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
  entryNames: watch ? "[name]" : "chunks/[name]-[hash]",
  metafile: true,
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

/** `head` for public/build/chunks/head-AB12CD34.js: the name a page's HTML gives a built file. */
const plainName = (file) => file.split("/").pop().replace(/(-[A-Z0-9]{8})?\.(js|css)$/, "");

/** The page each module is for: the leaderboard is `/`, the 404 page has no path of its own. */
const pagePath = (name) => (name === "leaderboard" ? "/" : name === "lost" ? null : `/${name}`);

/** public/_headers: site/_headers, then each page's module and the chunks it imports. */
function writeHeaders(metafile) {
  let text = readFileSync("site/_headers", "utf8");
  for (const [file, output] of Object.entries(metafile?.outputs ?? {})) {
    // A page's module only: a module loaded by import() (share-sheet.ts) is an entry point too.
    const path = output.entryPoint?.startsWith("site/pages/") && pagePath(plainName(file));
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

/** public/<page>.html: site/html/'s, each `/build/<name>.js` or `.css` pointing at the built file. */
function writeHtml(metafiles) {
  const built = new Map();
  for (const [file, output] of metafiles.flatMap((metafile) => Object.entries(metafile?.outputs ?? {}))) {
    const ext = /\.(js|css)$/.exec(file)?.[1];
    if (output.entryPoint && ext) built.set(`/build/${plainName(file)}.${ext}`, `/${file.replace(/^public\//, "")}`);
  }
  for (const page of readdirSync("site/html")) {
    const text = readFileSync(`site/html/${page}`, "utf8").replace(/\/build\/[\w-]+\.(js|css)\b/g, (ref) => {
      if (watch) return ref;
      const file = built.get(ref);
      if (!file) throw new Error(`site/html/${page} names ${ref}, which the build doesn't make`);
      return file;
    });
    writeFileSync(`public/${page}`, text);
  }
}

if (watch) {
  writeHeaders(null);
  writeHtml([]);
  for (const options of builds) await (await context(options)).watch();
  stdout.write(`Watching site/ → ${outdir}/
`);
} else {
  const built = await Promise.all(builds.map((options) => build(options)));
  writeHeaders(built[1].metafile);
  writeHtml(built.map((result) => result.metafile));
}
