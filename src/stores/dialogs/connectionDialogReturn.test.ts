/**
 * The connection manager is a workbench, like the shared-origin editor its
 * "edit at origin" link opens. The editor puts the manager aside on the way in
 * and gives it back on the way out, on the profile it was showing, and only
 * when it was the manager it was opened from (ADR #101).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { useOriginRepublish } from "@/stores/dialogs/originRepublish";

const manager = () => useConnectionDialog.getState();
const settings = () => useSettingsDialog.getState();
const editor = () => useOriginEditor.getState();

beforeEach(() => {
  useConnectionDialog.setState({
    open: false,
    initialId: null,
    focusedId: null,
    suspendedAt: null,
  });
  useSettingsDialog.setState({ open: false, section: "general", suspendedAt: null });
  useOriginEditor.setState({ originId: null, returnTo: null });
  useOriginRepublish.setState({ pending: null });
});

/** Open the manager the way `ConnectionDialog` does: on `initialId`, then
 *  reporting what it shows once the user moves to `showing`. */
function openManagerOn(initialId: string | null, showing = initialId) {
  manager().openManage(initialId);
  manager().focus(showing);
}

describe("suspend / resume", () => {
  it("brings the manager back on the profile it was showing", () => {
    // Opened on p1, the user clicked p2 in the rail.
    openManagerOn("p1", "p2");
    expect(manager().suspend()).toBe(true);
    expect(manager().open).toBe(false);
    manager().resume();
    expect(manager()).toMatchObject({ open: true, initialId: "p2", suspendedAt: null });
  });

  it("returns to a new draft when that is what it was showing", () => {
    manager().openNew();
    manager().focus(null);
    manager().suspend();
    manager().resume();
    expect(manager()).toMatchObject({ open: true, initialId: null });
  });

  it("does nothing when the manager was not open", () => {
    expect(manager().suspend()).toBe(false);
    manager().resume();
    expect(manager().open).toBe(false);
  });

  it("forgets the way back once the manager is opened or closed explicitly", () => {
    openManagerOn("p1");
    manager().suspend();
    manager().setOpen(false);
    manager().resume();
    expect(manager().open).toBe(false);

    openManagerOn("p1");
    manager().suspend();
    manager().openNew();
    manager().resume();
    expect(manager()).toMatchObject({ open: true, initialId: null });
  });
});

describe("the origin editor", () => {
  it("puts the manager aside and reopens it on the same connection", () => {
    openManagerOn("p1");
    editor().open("o1");
    expect(manager().open).toBe(false);
    expect(editor()).toMatchObject({ originId: "o1", returnTo: "connections" });

    editor().close();
    expect(editor()).toMatchObject({ originId: null, returnTo: null });
    expect(manager()).toMatchObject({ open: true, initialId: "p1" });
    // Settings was never involved.
    expect(settings().open).toBe(false);
  });

  it("gives back Settings, not the manager, when opened from Settings", () => {
    settings().openAt("origins");
    editor().open("o1");
    expect(editor().returnTo).toBe("settings");
    editor().close();
    expect(settings()).toMatchObject({ open: true, section: "origins" });
    expect(manager().open).toBe(false);
  });

  it("reopens nothing when opened with no workbench up", () => {
    editor().open("o1");
    expect(editor().returnTo).toBeNull();
    editor().close();
    expect(manager().open).toBe(false);
    expect(settings().open).toBe(false);
  });

  it("does not override an explicit open made while it was up", () => {
    openManagerOn("p1");
    editor().open("o1");
    // e.g. "Manage connections…" from the command palette.
    manager().openManage("p2");
    editor().close();
    expect(manager()).toMatchObject({ open: true, initialId: "p2" });
  });

  it("keeps the republish prompt's conflict hand-off returning to the manager", () => {
    // Saving keeps the manager open, and the prompt is a small dialog over it.
    openManagerOn("p1");
    useOriginRepublish.getState().open({
      originId: "o1",
      originName: "Team",
      profileId: "p1",
      profileName: "Prod",
      withSecret: false,
    });
    // A conflict closes the prompt and hands the document to the editor.
    useOriginRepublish.getState().close();
    editor().open("o1");
    expect(manager().open).toBe(false);
    editor().close();
    expect(manager()).toMatchObject({ open: true, initialId: "p1" });
  });

  it("keeps the republish hand-off closed when the manager had already closed", () => {
    // Connecting saves and then closes the manager before the prompt shows.
    openManagerOn("p1");
    manager().setOpen(false);
    editor().open("o1");
    editor().close();
    expect(manager().open).toBe(false);
  });
});
