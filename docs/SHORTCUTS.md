# Keyboard shortcuts

HuginnDB is meant to be driven from the keyboard. Every command it knows how
to run lives in one catalogue, and every entry in that catalogue can be given
a key — or several, or none.

Settings → Shortcuts is where you do that.

## How a binding is put together

A **chord** is one keypress with its modifiers: `Mod+K`, `Shift+F5`, `Space`.

A **sequence** is two chords in a row, separated by a space: `Mod+K Mod+S`.
Press the first, and HuginnDB waits — the status bar shows what it is waiting
for — until you press the second or two seconds pass. No shortcut ships as a
sequence; they exist so you have somewhere to put the commands that no longer
fit in a single combo.

`Mod` is the modifier you actually reach for: `Ctrl` on Windows and Linux,
`⌘` on macOS. It is written `Mod` when stored and drawn as the right symbol
for your platform. `Ctrl` and `Meta` also exist as exact tokens if you
specifically want the real Control or Command key.

## One action, several keys

An action can have more than one binding. The first is the **primary** one —
what menus, the command palette and tooltips display. The rest are aliases
that work just as well.

Click a key chip to record a different one, its `×` to drop it, or `+` to add
another. An action with no chips at all is unbound, which is a perfectly valid
state and how most of the catalogue ships: being listed already makes an
action searchable and bindable without spending a key on it.

## Where a shortcut is heard

Every action has a **scope**, shown on its row:

| Scope | Heard when |
| --- | --- |
| `global` | Anywhere in the app. |
| `editor` | The focus is in a SQL, view or pipeline editor. |
| `grid` | The focus is in the data grid. |
| `tree` | The focus is in the schema tree. |
| `overlay` | A palette or dialog is open. |

This is what lets two actions share a key without ambiguity: a binding in
`grid` and one in `editor` are never both audible, so both are allowed. Two
bindings clash only when their scopes overlap — a scope overlaps itself and
`global`.

When a key you are recording does clash, the dialog says which action holds it
and offers to take it away from that one.

**Inside a terminal**, the keyboard belongs to the terminal: a shell's
`Ctrl+R`, `Ctrl+K` or `Ctrl+B` must not toggle a panel. Only the command
palette, Preferences and the Console / Terminal toggles are heard there.

## Keys the app keeps

`Mod+R` always refreshes, on top of whatever you bind to that action. It
cannot be rebound or removed: it exists to stop the webview reloading the
whole app — and dropping your session with it — when you reach for the browser
reflex. Reserved keys are shown dimmed on their row rather than hidden, so
nothing about them is a surprise.

## Typing still wins

A shortcut that would be indistinguishable from typing — no `Mod`, `Ctrl`,
`Meta` or `Alt`, and a printable key — does not fire while the cursor is in a
text field. Bind an action to `A` and `A` still types an `A` in the connection
dialog.

Keys that produce no character are unaffected: `F5`, `Escape` and the arrows
work wherever the focus is.

## Finding a shortcut

The search box filters by action name. The **By key** chip turns it into a
capture field instead: press a combo and the list narrows to whoever uses it.
That is the way to answer "what does this key already do?" and "is this key
free?" before you bind anything.

**Modified** narrows the list to what you have changed. The reset button on a
row puts that action back to its default; **Reset all** clears every
customisation at once and asks first, because there is no undo.

## Moving them between machines

**Export** writes your customisations to a JSON file; **Import** replaces the
current set with a file's.

Only your *overrides* travel — not the resolved bindings. Exporting what every
action currently does would bake this version's defaults into the file, so
importing it on a newer build would pin you to yesterday's catalogue and quietly
opt you out of every default added since. If a file names an action this build
does not know, the import says so instead of dropping it in silence.

## Where it is stored

In `prefs.json`, in HuginnDB's config directory, under `keybindings` — a map
from action id to a list of bindings. Three states, all meaningful:

- **key absent** — that action uses its default
- **`[]`** — you unbound it on purpose
- **`["Mod+Enter", "F9"]`** — primary first, then aliases

An empty map is the fully-default state, which is why "Reset all" empties it
rather than writing every default back into it.
