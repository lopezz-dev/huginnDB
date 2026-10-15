/**
 * Host-platform detection, from the webview's user agent.
 *
 * Three call sites were each doing their own `navigator.userAgent` test with
 * their own casing and their own guard for `navigator` being absent — and one
 * of them (`CellEditor`'s `⌘S` chip) was open-coding what
 * `keybindings.ts::formatComboForDisplay` exists to do, contradicting that
 * module's own header, which claims to be "the only place that renders Ctrl as
 * ⌘ for macOS".
 *
 * The `typeof navigator` guard is not defensive noise: these modules are also
 * imported by Vitest, which runs most suites in a `node` environment with no
 * DOM. Both predicates return `false` there, which is the right answer for a
 * test that isn't asking about a platform.
 *
 * Deliberately *not* Tauri's `platform()` from `@tauri-apps/plugin-os`: that is
 * async, and every consumer here needs a synchronous answer during render.
 */

function ua(): string {
  return typeof navigator === "undefined"
    ? ""
    : navigator.userAgent.toLowerCase();
}

/** Whether the host is macOS — drives `⌘` rendering in shortcut hints. */
export function isMac(): boolean {
  return ua().includes("mac");
}

/**
 * Whether the host is Windows.
 *
 * Gates the SQL Server Windows-authentication modes in the connection dialog:
 * `tiberius`'s NTLM support is `cfg(windows)`-gated, so the backend refuses
 * those modes everywhere else and the UI must not offer them (see ADR #31).
 */
export function isWindows(): boolean {
  return ua().includes("windows");
}
