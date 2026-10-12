import { createRequire } from "node:module";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { contextMenuTemplate }: {
  contextMenuTemplate: (params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">) => MenuItemConstructorOptions[];
} = require("./editing.cjs");

const editFlags = {
  canUndo: false, canRedo: false, canCut: false, canCopy: false,
  canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
};

describe("desktop text context menu", () => {
  it("offers paste in an empty input without requiring selected text", () => {
    const menu = contextMenuTemplate({ isEditable: true, selectionText: "", editFlags });
    expect(menu).toContainEqual({ role: "paste", enabled: true });
    expect(menu).toContainEqual({ role: "copy", enabled: false });
    expect(menu).toContainEqual({ role: "cut", enabled: false });
  });

  it("follows Chromium's available editing actions", () => {
    const menu = contextMenuTemplate({
      isEditable: true, selectionText: "selected",
      editFlags: { ...editFlags, canUndo: true, canCut: true, canCopy: true, canPaste: false },
    });
    expect(menu).toContainEqual({ role: "undo", enabled: true });
    expect(menu).toContainEqual({ role: "redo", enabled: false });
    expect(menu).toContainEqual({ role: "cut", enabled: true });
    expect(menu).toContainEqual({ role: "copy", enabled: true });
    expect(menu).toContainEqual({ role: "paste", enabled: false });
  });

  it("allows copying selected reading text without offering edits", () => {
    expect(contextMenuTemplate({ isEditable: false, selectionText: "selected", editFlags: { ...editFlags, canCopy: true } }))
      .toEqual([{ role: "copy", enabled: true }]);
  });

  it("does not open an empty menu on the page background", () => {
    expect(contextMenuTemplate({ isEditable: false, selectionText: "", editFlags })).toEqual([]);
  });
});
