import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mindWeaverQuickNote", {
  loadState: () => ipcRenderer.invoke("quick-note:load-state"),
  submit: (payload) => ipcRenderer.invoke("quick-note:submit", payload),
  onPrefill: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("quick-note:prefill", listener);
    return () => ipcRenderer.removeListener("quick-note:prefill", listener);
  }
});
