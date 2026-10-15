/**
 * The two gestures every surface that lists connections needs: open one (and
 * warm its schema so the tree isn't empty for a beat), and close one (dropping
 * its cached schema and its tabs).
 *
 * Extracted while building the connections tree (#107), which would otherwise
 * have been a fourth copy. The older call sites — `FileMenu`, `StatusConnections`
 * and `CommandPalette` — still carry their own inlined versions; two are
 * behaviourally identical to this and one (`FileMenu`) reports failures through
 * `alert` instead of a toast. Consolidating them is a separate cleanup, not
 * something to fold into a feature commit.
 *
 * Deliberately store-level rather than a hook: it's called from click handlers,
 * and a couple of the call sites need it outside React's render cycle.
 */

import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { driverMismatchHint } from "@/lib/db/driver";

/**
 * Open the pool for `id` and load its schema. Returns whether it worked, so the
 * caller can decide what to focus — a profile whose password isn't in the
 * keychain, or whose host is unreachable, surfaces the driver's own message
 * (plus a hint when it looks like the wrong driver for the port) rather than
 * failing silently.
 */
export async function connectAndWarm(id: string): Promise<boolean> {
  try {
    await useConnections.getState().connect(id);
    // `quiet`, because this function reports the failure better than the store
    // can: with the profile's name and the wrong-driver hint. What it must not
    // do is treat a failed schema read as a successful connect — `refresh`
    // deliberately does not throw (one unreachable child must not abort a
    // fan-out), so awaiting it inside this `try` used to mean the `catch`
    // below was unreachable for any failure that happened *after* the pool
    // opened, and the app reported "Connected" for a server that had never
    // answered. MongoDB hit that on every connection, because its client is
    // lazy and `connect` therefore could not fail at all. See ADR #68.
    const failure = await useSchema.getState().refresh(id, { quiet: true });
    if (failure) return report(id, failure);
    // Connecting is the one gesture in the app that reliably takes seconds —
    // a handshake, a keychain read, sometimes an SSH tunnel — which is long
    // enough that people start it and look somewhere else. The tree filling in
    // only says so to whoever is still watching the tree.
    notify.success(i18n.t("connections.connected"), {
      description: profileName(id),
    });
    return true;
  } catch (e) {
    return report(id, String(e));
  }
}

/**
 * Report a failed connect and answer `false`, so the two exits above cannot
 * drift: one is the pool refusing to open and the other is the schema read
 * failing behind a pool that did open, and the user is owed the same card
 * either way.
 *
 * The profile's name goes in the title and the driver's message in the
 * description — the app's convention for a reported failure, and the reason
 * it matters here is that the message alone does not say *which* connection
 * with eight of them in the tree. Errors are always cards (`surfaceFor`), so
 * the description costs nothing and arrives monospaced with the free
 * "Copy error" action.
 */
function report(id: string, message: string): false {
  const hint = driverMismatchHint(message);
  notify.error(i18n.t("connections.connectFailed", { name: profileName(id) }), {
    description: hint ? `${message} — ${hint}` : message,
  });
  return false;
}

/**
 * Tear down the pool for `id` and everything hanging off it: the cached schema
 * (so a later reconnect refetches instead of showing a stale tree) and the tabs
 * that pointed at it. Errors are swallowed — a pool that was already dead should
 * still leave the UI in a clean state.
 *
 * Deliberately silent on success, unlike {@link connectAndWarm}: the tree row
 * greys out and the connection's tabs close, so the screen has already said it
 * (CONTRIBUTING → "Feedback and transition state": confirm a write only when
 * its effect is not self-evident). {@link disconnectAll} is the exception, and
 * only for its count.
 */
export async function disconnectAndClean(
  id: string,
  opts?: { persistLaunch?: boolean },
): Promise<void> {
  try {
    // `closeTabs`: the tabs go when the tree does, not once the backend has
    // finished closing the pool in the background — which over SSH is
    // seconds later, and looked like the disconnect had only half happened.
    await useConnections.getState().disconnect(id, { ...opts, closeTabs: true });
    useSchema.getState().drop(id);
  } catch {
    // Non-fatal: leave the rest of the UI untouched on a teardown error.
  }
}

/**
 * Close every live pool, concurrently.
 *
 * **Why this is one function and not two loops.** "Disconnect all" had two
 * implementations that disagreed on both axes that matter. The connections
 * tree awaited each connection in turn *and* cleaned up after each (schema
 * cache, tabs); the keyboard shortcut and the command palette fired them all
 * off with `void` *and* cleaned up neither, leaving a stale tree and tabs
 * pointing at closed pools. So the same command was slow and correct from one
 * surface, fast and lossy from another.
 *
 * **Why concurrency is the fix rather than a nicety.** A single disconnect is
 * not one round trip: the backend closes each synthetic `<parent>::db::<db>`
 * pool in turn — every one of them up to `CLOSE_TIMEOUT` (5s) if the server
 * has stopped answering — before closing the parent's, and the frontend
 * flushes one tab-state snapshot per child on top of that. Serialising the
 * *connections* on top of all that nesting is what turned "disconnect all"
 * into a visible wait, and one unreachable server made every healthy one
 * behind it wait out its timeout first. `allSettled`, not `all`: one pool that
 * refuses to close must not abandon the rest half-torn-down.
 *
 * The launch-state write is suppressed per connection and done once at the
 * end — see `useConnections.disconnect`'s `persistLaunch` for the race that
 * otherwise makes the *last* of N concurrent writes the winner.
 */
export async function disconnectAll(): Promise<void> {
  const ids = Array.from(useConnections.getState().active);
  if (ids.length === 0) return;
  await Promise.allSettled(
    ids.map((id) => disconnectAndClean(id, { persistLaunch: false })),
  );
  await persistLaunchState(Array.from(useConnections.getState().active));
  // A count, which is the part the screen cannot tell you: the tree just
  // collapses, and "did that get all of them" is exactly the question a
  // command called "disconnect all" leaves behind.
  notify.success(i18n.t("connections.disconnectedAll", { count: ids.length }));
}

/** Profile name for a notification, falling back to the id we were given. */
function profileName(id: string): string {
  return (
    useConnections.getState().profiles.find((p) => p.id === id)?.name ?? id
  );
}
