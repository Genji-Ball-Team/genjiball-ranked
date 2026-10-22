/** A value as the JSON parameter of a bulk query: `json_each(?1)` reads it back as rows. */
export const json = (value: unknown): string => JSON.stringify(value);
