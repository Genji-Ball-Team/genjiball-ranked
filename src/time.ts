/** ISO 8601 in UTC without milliseconds, the format the schema's defaults use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
