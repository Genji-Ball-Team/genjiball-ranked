// The Content-Security-Policy's hashes for the <style> elements @genji-ball-team/ui's components put
// in their shadow roots (scripts/build-site.mjs puts them in public/_headers, site/_headers says why).
// Each component's styles are a constant in its module, some built from shared parts, so the build
// loads the modules with just enough of a DOM to run their top level, and hashes what they'd set.
// A component that makes a <style> this can't follow fails the build: the policy would block it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const ui = "node_modules/@genji-ball-team/ui/dist";

/** How a component fills a <style>: `style.textContent = styles;` or `innerHTML = `<style>${styles}</style>…``. */
const fills = [/\bstyle\.textContent = (\w+);/g, /<style>\$\{(\w+)\}<\/style>/g];
const makes = /createElement\("style"\)|`<style>/g;

/** Each UI module that makes a <style>, with the constants it fills them from. */
function styleConstants() {
  const found = new Map();
  for (const file of readdirSync(ui).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(`${ui}/${file}`, "utf8");
    const names = fills.flatMap((fill) => [...source.matchAll(fill)].map((m) => m[1]));
    const made = source.match(makes)?.length ?? 0;
    if (made !== names.length) {
      throw new Error(`${ui}/${file} makes ${made} <style> elements, but only ${names.length} from a constant the CSP can hash`);
    }
    if (names.length) found.set(file, [...new Set(names)]);
  }
  return found;
}

/** The text of every <style> a UI component makes. */
export async function componentStyles() {
  const found = styleConstants();
  const result = await build({
    stdin: { contents: [...found.keys()].map((file) => `import "./${file}";`).join("\n"), resolveDir: ui, loader: "js" },
    bundle: true,
    format: "iife",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "hand-out-styles",
        setup(b) {
          b.onLoad({ filter: /[\\/]@genji-ball-team[\\/]ui[\\/]dist[\\/][\w-]+\.js$/ }, (args) => {
            const names = found.get(basename(args.path));
            const source = readFileSync(args.path, "utf8");
            return { contents: names ? `${source}\nglobalThis.styles.push(${names.join(", ")});` : source, loader: "js" };
          });
        },
      },
    ],
  });
  const styles = [];
  runInNewContext(result.outputFiles[0].text, {
    styles,
    HTMLElement: class {},
    customElements: { get: () => undefined, define: () => {} },
  });
  return [...new Set(styles)];
}

/** `'sha256-…'`: the CSP source for a <style> with this text. */
export const hashSource = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** site/_headers' policy, `{component-styles}` replaced by the hashes of the UI's <style> texts. */
export async function withStyleHashes(headers) {
  if (!headers.includes("{component-styles}")) throw new Error("site/_headers has no {component-styles} in its Content-Security-Policy");
  const hashes = (await componentStyles()).map(hashSource).sort();
  return headers.replaceAll("{component-styles}", hashes.join(" "));
}
