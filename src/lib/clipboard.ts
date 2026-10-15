/**
 * The app's one clipboard seam.
 *
 * **Both halves go through Tauri's clipboard plugin, never
 * `navigator.clipboard`** — the webview's own Clipboard API was wrong for this
 * app in two separate, user-visible ways (ADR #63):
 *
 *  - `readText()` triggers WebView2's native "allow this site to see text and
 *    images copied to the clipboard" prompt. It fires on Ctrl+V inside a
 *    desktop app the user already trusts, it is the engine's dialog rather than
 *    HuginnDB's, and there is no API to style, pre-grant or reword it while the
 *    read happens in JS. Reading from Rust removes the question instead of
 *    answering it.
 *  - `writeText()` lands in the webview's own clipboard channel. Pasting back
 *    into HuginnDB worked, which is what made this look fine, but the value was
 *    never in the *system* clipboard: copy something else and the cell you
 *    copied was simply gone, and it never appeared in the OS clipboard history.
 *    The plugin writes through arboard, so it lands where the user's other apps
 *    look.
 *
 * The `navigator.clipboard` fallback is kept for one case only: the frontend
 * running outside the Tauri shell (`pnpm dev` in a plain browser), where the
 * plugin's IPC has nothing to talk to. It is not a "in case the plugin fails"
 * hedge — inside the shell the plugin is the path.
 *
 * Failures past that are deliberately silent. The user pressed Ctrl+C, nothing
 * landed, and the next paste says so more clearly than a toast would.
 *
 * Lives here rather than under `lib/grid/` because it stopped being the grid's
 * a while ago: `notify`, the notification card, the schema tree, the pipeline
 * exporter and the MCP settings panel all copy through it.
 */
import {
  readText as pluginReadText,
  writeText as pluginWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

/** Write `text` to the system clipboard, swallowing a denial. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await pluginWriteText(text);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // See above: visually obvious to the user, nothing to surface.
    }
  }
}

/**
 * Read the system clipboard as text, or `null` when it holds nothing readable.
 *
 * Callers treat `null` as "do nothing" rather than as an error — the paste
 * chord in the grid has no useful thing to say about an empty clipboard.
 */
export async function readFromClipboard(): Promise<string | null> {
  try {
    return await pluginReadText();
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
}
