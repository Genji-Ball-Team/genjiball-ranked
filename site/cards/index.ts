// The card styles the share sheet offers. Each draws all three cards (player, match, compare) in
// both sizes, from the same data, showing only the parts picked in the sheet (parts.ts).
import * as broadcast from "./broadcast";
import * as classic from "./classic";
import * as climb from "./climb";
import { showFor, type ComparePart, type MatchPart, type PlayerPart, type Show } from "./parts";
import * as sheet from "./sheet";
import * as spotlight from "./spotlight";
import type { ShareCard } from "./types";

type Draw<T, P extends string> = (ctx: CanvasRenderingContext2D, W: number, H: number, card: T, tall: boolean, on: Show<P>) => void;

interface Style {
  label: string;
  playerCard: Draw<Extract<ShareCard, { kind: "player" }>, PlayerPart>;
  matchCard: Draw<Extract<ShareCard, { kind: "match" }>, MatchPart>;
  compareCard: Draw<Extract<ShareCard, { kind: "compare" }>, ComparePart>;
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

/** Draws `card` in `style` with the `picked` parts onto the canvas, which is the size's width and height. */
export function drawCard(ctx: CanvasRenderingContext2D, style: StyleName, card: ShareCard, tall: boolean, picked: readonly string[]): void {
  const { width: W, height: H } = ctx.canvas;
  const s: Style = styles[style];
  if (card.kind === "player") s.playerCard(ctx, W, H, card, tall, showFor(card, picked));
  else if (card.kind === "match") s.matchCard(ctx, W, H, card, tall, showFor(card, picked));
  else s.compareCard(ctx, W, H, card, tall, showFor(card, picked));
}
