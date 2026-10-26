// Host a lobby (host.html): the steps are the page's own. This adds the host tool's newest version
// next to the download, from GitHub; without an answer it keeps saying "latest release".
import { byId } from "../lib/html";
import { start } from "../shell";

const latestRelease = "https://api.github.com/repos/Genji-Ball-Team/genjiball-host-tool/releases/latest";

async function hostPage(): Promise<void> {
  try {
    const res = await fetch(latestRelease, { headers: { Accept: "application/vnd.github+json" } });
    const { tag_name: tag } = res.ok ? ((await res.json()) as { tag_name?: string }) : {};
    if (tag) byId("tool-version").textContent = tag;
  } catch {
    // GitHub didn't answer: "latest release" stays.
  }
}

start("host", hostPage);
