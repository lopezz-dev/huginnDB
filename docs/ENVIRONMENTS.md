# Environments

An **environment** is a named set of connections plus the whole working session
that belongs to them: which tabs are open, how the panes are split, which
connection has focus, and what reconnects when you come back to it.

The switcher lives in the topbar, left of the breadcrumb. Pick another
environment and HuginnDB puts the current session away, closes the live
connections, and brings up the other one's — the tabs you had, arranged the way
you left them, filtered and sorted the way you left them.

The case it exists for: you work with several clients or sites, each with its own
handful of servers. Before this, keeping them apart meant a window per client
and rebuilding the layout by hand every morning. Now it's one switcher.

## What an environment does and doesn't own

**It does not own your connections.** There is one global list of connections,
exactly as before. An environment decides which of them are *in play* — it
doesn't take them over.

That distinction is what makes deleting one safe. Deleting an environment
discards its remembered tabs and its pane layout. It never deletes a connection,
and it never touches a stored password: those live in `profiles.json` and your
operating system's keychain, both outside the environment entirely. The
confirmation dialog says so, because "delete environment" can easily read the
other way round.

The reverse direction *does* propagate: deleting a **connection** removes it from
every environment that remembered it. Otherwise it would come back as a tab
pointing at a connection that no longer exists the moment you switched.

## What each environment remembers

- Open table and query tabs, including their colour and pinned state.
- For table tabs: the column filters, the multi-level sort, and the search you
  committed. Only what was actually applied — a half-typed search box isn't
  saved.
- The split/float arrangement of the workspace panes.
- Which connections were live, which one had focus, and which tab was showing.
- Which nodes you had expanded in the schema tree, and which connections you had
  folded in it. A connection's row is open whenever the connection is, so only
  your folds need remembering.

Structure-editor and view-editor tabs are deliberately **not** remembered. They
are in-progress editing sessions, not places you return to.

Each environment remembers the 20 most recently used connections independently.
The cap is per environment on purpose: a global one would let a busy environment
quietly evict the tabs of one you hadn't opened in a while.

## Shared origins

An environment can also get its connections from somewhere else: a **shared
origin** is a file on a path your machine already reaches — a UNC share, a mapped
drive, a synced folder — that HuginnDB imports connections from, passwords
included. The point is that somebody joining a team configures nothing by hand.

Publishing one is just "Export profiles" with a passphrase, dropped on the
share. Consuming it is Settings → **Shared origins**: give it the path, enter the
passphrase once, and the connections appear. The passphrase is kept in your own
keychain, per origin, and never written to disk. The registry is **global**, not
part of any one environment: an origin describes a file on a share, not a
Producción/Staging axis, and what it produces — connections, whole mirrored
environments — is global too.

For everyone consuming one it only goes one way. HuginnDB reads that path, and a
connection that came from an origin is read-only — the next sync would undo a
local edit anyway. If you need a variant, duplicate it: the copy is yours, fully
editable, and no longer tied to the origin. The one exception is the machine that
publishes the origin: it can correct a connection — a wrong password, most often
— right there in the same dialog, under the same id, and republish it from the
document editor when ready; no duplicate, nothing left behind to clean up.

An environment's colour, icon, name and theme are different: those you can always
personalise locally, even while the environment stays mirrored — open its rename
dialog, pick what you like, and it's remembered on this machine only. The next
sync keeps everything else about the environment (which connections it groups)
in step with the origin, and a "follow the origin again" button drops your
override if you change your mind.

### Curating one (1.19.0)

If you are the person who publishes the file, mark the origin as one **this
machine publishes** (Settings → Shared origins → edit the registration). That is
a deliberate, reversible switch, and it is the only thing that lets HuginnDB
write to that path — every origin starts without it, so updating the app never
grants it. Your OS still has the last word: the editor probes the path with a
real write and opens read-only if the share refuses, rather than letting you
compose a revision and failing at the last step.

Then "Edit the document" opens a full-screen editor for the file itself:

* **Connections** — two columns, this machine on the left and the file on the
  right. Nothing you do here touches your own connections; moving one across
  copies it into the document. Each published row says how its password travels:
  unchanged (the cheap default), encrypted from your keychain, or not at all, in
  which case the other end is asked for it.
* **Environments** — the cosmetics and the membership each one publishes. A
  connection in no environment is still published; it is just loose.
* **JSON Schemas** — the library slice and the bindings that ride along, so one
  file can set up a whole machine.
* **Publish** — who curates the file, a revision note, the passphrase, and the
  report below.

Before writing anything it tells you what publishing does to everyone pulling
from it: what is added, what genuinely changes, what disappears — and, when it
matters, that a batch of disappearances is large enough that **nobody will be
warned about it** (see the "don't trust this read" rule further down; a publisher
crossing that line silently leaves the whole team with connections that no longer
exist). It also prices the passwords: a password that has not changed travels
byte for byte, so renaming an environment costs the team nothing, while rotating
the passphrase re-encrypts everything and makes everyone re-derive a key per
password on their next sync.

The file is written atomically, with the previous revision kept alongside it as
`<name>.json.bak`, and the editor compares the file's contents when you publish:
if somebody else published while you had it open, your revision is refused and
you are shown theirs instead of overwriting them.

Origins re-sync when you launch HuginnDB, every few hours, and whenever you press
**Sync now**. A metadata change (a moved host or port) for a connection you
currently have open waits until you disconnect it — repointing a live connection
mid-query would silently move you to a different server.

**A sync never deletes anything on its own.** If a connection stops appearing in
the file, you get a standing notice — in the schema tree and in Settings, not a
dialog interrupting you — with two choices: keep it as your own, which detaches it
from the origin and makes it editable again, or delete it along with its stored
password. Your choice is remembered. Someone else editing the shared file must not
be able to remove credentials from your machine.

Two situations are deliberately treated as "don't trust this read": a file that
can't be read or parsed (share offline, VPN down, the publisher saving it right
then) changes nothing at all, and a file that has cleanly lost half of an origin's
connections at once reports nothing until you look into it. Both would otherwise
bury you in removal notices for connections that are perfectly alive.

Worth being clear about the security of this, because the encryption can be
misleading: anyone who can read the share **and** has the passphrase has every
password in that file. The passphrase has to reach people some other way, so the
protection that actually matters is the folder's permissions. Treat an origin file
as a credential store. `SECURITY.md` in the repository spells this out.

Removing an origin forgets its stored passphrase. The connections it imported stay
— they're already yours at that point, and deleting them isn't something removing
a bookmark should do.

## Switching is not instantaneous

A switch closes every open pool and opens the incoming environment's. It takes
about as long as connecting to those servers normally does, and the switcher
shows a spinner and refuses further clicks while it works. This is real work, not
a UI transition — if a server is slow to answer, the switch is slow.

A connection that fails to come back (unreachable host, password no longer in the
keychain) is skipped without blocking the rest, the same as at startup.

Reconnecting on entry follows the **Reconnect on launch** preference. With it
turned off, switching still changes which environment is active and still records
what you had open, but it won't reopen connections or restore the layout — layout
restore rides along with reconnect by design.

## The upgrade from an earlier version

Nothing is lost. Whatever session you had becomes a single environment holding it
verbatim, so the first launch after updating looks exactly like the last one
before it. From there you can rename it and add more.

That first environment starts **unnamed** and displays as "Default" in whichever
language the interface is set to. That's deliberate: if HuginnDB wrote a name
into your data it would be stuck in one language forever. Give it a name and the
name is yours.

One thing worth knowing before you update: the session file (`tab_state.json`)
moves to a new format, and **an older build of HuginnDB will not understand
it**. Going back to a previous version means it starts with an empty session —
your connections and passwords are untouched, but the remembered tabs and layout
are not readable by it. If you want to try a pre-release without that risk, the
canary build keeps its session state in a directory of its own, side by side with
your stable install (see `docs/CANARY.md` in the repository).

## Secondary windows

Environments belong to the main window. **Window → New window** opens a
deliberately ephemeral instance: it never writes session state, so closing it
loses its tabs by design. Switching in the main window doesn't disturb an open
secondary one.

To keep working in your current environment and open another beside it,
right-click that environment in the rail and choose **Open environment in new
window**. The new window shows that environment's connections and database
filters and reconnects the connections it had open (reusing a pool the main
window already has, so nothing is opened twice). Tabs and pane layout are not
carried over — they belong to the main window — and nothing the new window does
changes which environment the main window is in or what gets reopened at
launch.

## Practical notes

- Renaming to an empty name clears your name and brings the localised default
  back. Creating an environment does require a name — an unnamed new one would
  be indistinguishable from the default.
- An environment is drawn as the initials of its name over its accent colour,
  or as a custom avatar image if you give it one (pick a file, or drop one on
  the preview in the create/rename dialog). Both are cosmetic; nothing behaves
  differently. The image is stored inside the environment itself, cropped square
  and downscaled to 128px, so it is copied when you replicate one and discarded
  when you delete one — there is no separate file to manage.
- The last environment can't be deleted. There is always exactly one active.
