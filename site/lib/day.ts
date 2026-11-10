// Lists grouped by day (duels, matches): a heading for each day, in the viewer's time zone.

/** The time of day, "20:15" or "8:15 PM" as the viewer's locale writes it. */
export const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });

/** "Today", "Yesterday" or the date: the heading of a day's rows. */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const thisYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: thisYear ? undefined : "numeric" });
}
