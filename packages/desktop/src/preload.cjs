const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setup", {
  onSteps: (fn) => ipcRenderer.on("steps", (_e, steps) => fn(steps)),
  onStep: (fn) => ipcRenderer.on("step", (_e, step) => fn(step)),
  recheck: () => ipcRenderer.send("recheck"),
  onFailed: (fn) => ipcRenderer.on("failed", (_e, info) => fn(info)),
  onHelp: (fn) => ipcRenderer.on("help", (_e, help) => fn(help)),
  open: (url) => ipcRenderer.send("open", url),
  // A payload means a crash in the page can use the same reporter as one in the shell: written
  // to crash.log, then the dialog with Report and Copy. Without one only the shell could report.
  report: (details) => ipcRenderer.send("report", details),
  // Progress for an update the user asked for. null ends it — downloaded, cancelled or failed.
  onUpdateProgress: (fn) => ipcRenderer.on("update-progress", (_e, progress) => fn(progress)),
});
