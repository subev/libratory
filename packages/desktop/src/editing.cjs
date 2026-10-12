/** @param {import("electron").ContextMenuParams} params
 * @returns {import("electron").MenuItemConstructorOptions[]} */
function contextMenuTemplate({ isEditable, selectionText, editFlags }) {
  if (isEditable) {
    return [
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    ];
  }
  return selectionText ? [{ role: "copy", enabled: editFlags.canCopy }] : [];
}

module.exports = { contextMenuTemplate };
