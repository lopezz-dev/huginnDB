/**
 * Thin wrappers over Tauri's native file dialogs.
 *
 * The plugin's `open()` returns `string | string[] | null` — the array form for
 * a multi-select it was not asked for — so every caller has to narrow it, and
 * six of them wrote `if (typeof picked !== "string") return;` with three
 * different spellings of the empty check on top. These collapse that to `null`
 * once, so a call site can read `if (!path) return;`.
 */

import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";

/**
 * Ask the user for one JSON file. `null` when they cancel.
 *
 * `extensions` defaults to `["json"]`; the JSON-Schema library passes
 * `["json", "schema.json"]` so a `foo.schema.json` is offered too.
 */
export async function pickJsonFile(
  title: string,
  extensions: string[] = ["json"],
): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title,
    filters: [{ name: "JSON", extensions }],
  });
  return typeof picked === "string" && picked ? picked : null;
}

/**
 * Ask the user for a file to import into a table (ADR #139): CSV, JSON or
 * Excel. `null` when they cancel. The extensions are the ones
 * `ImportFormat::from_path` in `db/import_file.rs` accepts.
 */
export async function pickImportFile(title: string): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title,
    filters: [
      {
        name: "CSV, JSON, Excel",
        extensions: ["csv", "tsv", "txt", "json", "xlsx", "xlsm"],
      },
    ],
  });
  return typeof picked === "string" && picked ? picked : null;
}

/**
 * Ask the user where to create one JSON file. `null` when they cancel.
 *
 * The counterpart of {@link pickJsonFile} for the one flow that needs a
 * destination rather than a source: creating a shared origin's document. The
 * export commands do this in Rust (`transfer::save_export`) because they write
 * there themselves; this one only needs the path, since
 * `create_origin_document` refuses an existing file and does its own atomic
 * write.
 */
export async function pickJsonSavePath(
  title: string,
  suggestedName: string,
): Promise<string | null> {
  const picked = await saveFileDialog({
    title,
    defaultPath: suggestedName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  return typeof picked === "string" && picked ? picked : null;
}
