/**
 * A locale file flattened to the dotted keys i18next resolves, each with its
 * string. Shared by the tests that read the locales as data (missing keys,
 * ellipsis on labels, Spanish terms) so they agree on what a key is.
 */
export function localeEntries(value: unknown, prefix = ""): [key: string, text: string][] {
  if (typeof value !== "object" || value === null) return [[prefix, String(value)]];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    localeEntries(v, prefix ? `${prefix}.${k}` : k),
  );
}
