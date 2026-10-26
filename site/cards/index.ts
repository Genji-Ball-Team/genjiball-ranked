// The card styles the share sheet offers. Each draws all three cards (player, match, compare) in
// both sizes, from the same data.
import * as broadcast from "./broadcast";
import * as classic from "./classic";
import * as climb from "./climb";
import * as sheet from "./sheet";
import * as spotlight from "./spotlight";
import type { ShareCard } from "./types";

type Draw<T> = (ctx: CanvasRenderingContext2D, W: number, H: number, card: T, tall: boolean) => void;

interface Style {
  label: string;
  playerCard: Draw<Extract<ShareCard, { kind: "player" }>>;
  matchCard: Draw<Extract<ShareCard, { kind: "match" }>>;
  compareCard: Draw<Extract<ShareCard, { kind: "compare" }>>;
}

export const styles = {
  broadcast: { label: "Broadcast", ...broadcast },
  climb: { label: "Climb", ...climb },
  sheet: { label: "Sheet", ...sheet },
  spotlight: { label: "Spotlight", ...spotlight },
  classic: { label: "Classic", ...classic },
} satisfies Record<string, Style>;

export type StyleName = keyof typeof styles;
export const isStyle = (value: string | null | undefined): value is StyleName => value != null && Object.hasOwn(styles, value);

/** Draws `card` in `style` onto the canvas, which is the size's width and height. */
export function drawCard(ctx: CanvasRenderingContext2D, style: StyleName, card: ShareCard, tall: boolean): void {
  const { width: W, height: H } = ctx.canvas;
  const s: Style = styles[style];
  if (card.kind === "player") s.playerCard(ctx, W, H, card, tall);
  else if (card.kind === "match") s.matchCard(ctx, W, H, card, tall);
  else s.compareCard(ctx, W, H, card, tall);
}
