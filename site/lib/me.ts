// "This is me": the player this browser belongs to, set on their page, highlighted on the leaderboard.
const key = "me";

/** The remembered player's id, or null. */
export function me(): number | null {
  try {
    const id = Number(localStorage.getItem(key));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Remembers the player, or forgets them with null. */
export function setMe(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(id));
  } catch {
    // Storage off: the choice lasts until the page closes.
  }
}
