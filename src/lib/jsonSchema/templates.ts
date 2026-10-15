/**
 * Starting points for the empty library.
 *
 * An empty library plus a "New" button is a blank Monaco buffer, and writing JSON
 * Schema from memory is exactly the friction that kills adoption. These three
 * cover the shapes the configuration-store use case actually needs, and the third
 * exists specifically because enum completion is the most valuable thing Monaco
 * gives you here and nobody remembers the syntax.
 *
 * The bodies are literal JSON and deliberately untranslated: a schema body is
 * *data*, not copy. Only the names and descriptions are i18n keys — the same
 * reasoning that keeps the backend from ever writing display copy into an
 * environment's `name` (ADR #27).
 *
 * Each one states `$schema`, which is load-bearing rather than decorative:
 * without it Monaco validates with 2020-12 semantics instead of draft-07.
 */

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

export interface SchemaTemplate {
  id: "object" | "strict" | "enumField";
  /** i18n key for the button label. */
  nameKey: string;
  /** i18n key for the one-line explanation. */
  descKey: string;
  body: string;
}

export const SCHEMA_TEMPLATES: SchemaTemplate[] = [
  {
    id: "object",
    nameKey: "jsonSchemas.templates.object.name",
    descKey: "jsonSchemas.templates.object.desc",
    body: JSON.stringify(
      {
        $schema: DRAFT_07,
        type: "object",
        properties: {
          title: { type: "string", description: "Shown as the widget heading." },
          enabled: { type: "boolean", default: true },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "strict",
    nameKey: "jsonSchemas.templates.strict.name",
    descKey: "jsonSchemas.templates.strict.desc",
    body: JSON.stringify(
      {
        $schema: DRAFT_07,
        type: "object",
        required: ["version", "layout"],
        additionalProperties: false,
        properties: {
          version: { type: "integer", minimum: 1 },
          layout: {
            type: "object",
            properties: {
              columns: { type: "integer", minimum: 1, maximum: 12 },
            },
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "enumField",
    nameKey: "jsonSchemas.templates.enumField.name",
    descKey: "jsonSchemas.templates.enumField.desc",
    body: JSON.stringify(
      {
        $schema: DRAFT_07,
        type: "object",
        properties: {
          chartType: {
            type: "string",
            description: "Suggested in the editor as you type.",
            enum: ["line", "bar", "area", "pie"],
          },
        },
      },
      null,
      2,
    ),
  },
];
