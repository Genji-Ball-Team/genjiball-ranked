export const minuteMs = 60 * 1000;
export const hourMs = 60 * minuteMs;
export const dayMs = 24 * hourMs;

/** ISO 8601 in UTC without milliseconds, the format the schema's defaults use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `seconds` before `now`, as `isoSeconds`: a lobby last seen at or before it is past `seconds` old. */
export function secondsBefore(now: Date, seconds: number): string {
  return isoSeconds(new Date(now.getTime() - seconds * 1000));
}
