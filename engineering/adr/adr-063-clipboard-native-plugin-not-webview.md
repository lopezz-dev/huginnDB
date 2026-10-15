---
id: 63
type: adr
status: accepted
date: 2026-09-07
tags: [webview2, tauri, ui]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #63: The clipboard is read and written natively, never through `navigator.clipboard`

The webview's own Clipboard API failed this app in two separate, user-visible ways — `readText()` raises WebView2's native permission prompt on an ordinary Ctrl+V, and `writeText()` never reaches the system clipboard — so both halves go through `tauri-plugin-clipboard-manager` behind one seam, `src/lib/clipboard.ts`.

**External trap behind it:** In WebView2, navigator.clipboard.readText() raises the engine's own permission prompt and writeText() stays in the webview's channel instead of reaching the system clipboard.

**Decision:** All clipboard reads and writes go through tauri-plugin-clipboard-manager behind src/lib/clipboard.ts, with navigator.clipboard used only as the plain-browser fallback and only read-text/write-text capabilities granted.

**Alternatives rejected:**

- navigator.clipboard in the webview: rejected because readText raises WebView2's permission prompt and writeText never reaches the OS clipboard.
- Two hand-rolled Tauri commands over arboard directly: rejected because the plugin's permission model and upstream maintenance won, despite ~32 extra crates.
- default-features = false on arboard to drop image-data: does not work because Cargo feature unification is additive.
- Granting the plugin's :default permission set: rejected in favour of only allow-read-text and allow-write-text.

## Detail

**Two bugs, one cause: the clipboard was the webview's, not the OS's.**

- **Reading raised a prompt the app could not govern.** `useGridKeyboardNav`'s paste chord called `navigator.clipboard.readText()`, and Chromium/WebView2 answers that with its own "allow this site to see text and images copied to the clipboard" dialog. In a browser tab that is correct; in an installed desktop app, on a paste the user just asked for, it reads as the app asking permission to do the thing it was told to do — and it is the *engine's* dialog, so there is no API to style it, reword it, pre-grant it or route it through HuginnDB's own UI while the read happens in JS. The fix is not to answer the question but to stop asking it: the read now happens in Rust, where no webview permission model is involved.
- **Writing never left the webview.** Every copy path called `navigator.clipboard.writeText()`. Pasting back *into* HuginnDB worked, which is exactly what made this look healthy for so long — but the value was in the webview's own channel, not the system clipboard. Copy a cell, copy anything else in any other app, and the cell was simply gone; it never showed up in the OS clipboard history (Win+V) either. The plugin writes through `arboard`, so a copied value lands where the user's other applications look for it.

**The rule this leaves.** `navigator.clipboard` appears in exactly one file, `src/lib/clipboard.ts`, and only as the fallback for running the frontend outside the Tauri shell (`pnpm dev` in a plain browser), where the plugin's IPC has nothing to talk to. It is not a defensive "in case the plugin fails" hedge — inside the shell the plugin *is* the path, and a `navigator.clipboard` call anywhere else is the bug coming back. Both halves are exported from that seam (`copyToClipboard`, `readFromClipboard`) and `src/lib/clipboard.test.ts` pins the delegation.

**Why one seam and not seven.** Before this, the helper existed but six call sites bypassed it and called `navigator.clipboard.writeText` directly — the schema tree's two copy actions, the pipeline output and its export dialog, the MCP settings copy button, the status bar's history fallback and the connection dialog's error copier. They shared nothing, including the error handling, so the migration had to find all seven rather than change one. The file also moved out of `lib/grid/`: it had stopped being the grid's the moment `lib/notify.tsx` started importing it.

**Three optimistic confirmations became real ones.** `McpSection`, `ExportPipelineDialog` and `ConnectionDialog` fired their "Copied" toast/state without awaiting the write, which was defensible when the call was a webview-local no-op-or-succeed. Now that it is an IPC round trip to the OS clipboard, a failure is detectable, so the confirmation follows the write instead of racing it.

**The dependency cost is real and was accepted.** `tauri-plugin-clipboard-manager` pulls `arboard`, and `arboard`'s default `image-data` feature drags in `image` and its decoders (`tiff`, `fax`, `zune-*`, `weezl`, …) plus the X11/Wayland clipboard backends on Linux — about 32 crates for a feature this app does not use. There is no way to trim it from here: the plugin declares `arboard` with default features on, and Cargo's feature unification is additive, so a `default-features = false` entry of our own would not turn `image-data` off. The alternative was two hand-rolled commands over `arboard` directly; the plugin's permission model and upstream maintenance won. If the tree ever needs trimming, that swap is the lever — not a `[patch]` on `arboard`.

**Capability, not `:default`.** The permissions are listed as `clipboard-manager:allow-read-text` and `clipboard-manager:allow-write-text` in `src-tauri/capabilities/default.json`, matching how `opener` is scoped there rather than granting the plugin's whole default set (which also covers image and HTML clipboard commands the app never calls).

## Known limits

- **Linux clipboards are owner-based.** On X11 (and Wayland without a data-control manager) the clipboard contents belong to the process that set them, so a value copied from HuginnDB disappears when HuginnDB exits. `arboard`'s `wayland-data-control` feature is enabled by the plugin, which covers Wayland compositors that support it. This is a platform property, not a regression, and Windows — the primary target — is unaffected.
- **Ctrl+C / Ctrl+V still do not reach the Mongo document list view** (`viewMode === "list"`, where `DataGrid` deliberately hands `onKeyDown` off), and neither chord is in `lib/keybindings/actions.ts`, so they are not rebindable. Both predate this change and are untouched by it.
