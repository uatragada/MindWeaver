import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mindWeaverSetup", {
  loadState: () => ipcRenderer.invoke("desktop-setup:load-state"),
  submit: (payload) => ipcRenderer.invoke("desktop-setup:submit", payload),
  launchChrome: (payload) => ipcRenderer.invoke("desktop-setup:launch-chrome", payload),
  openExtensionFolder: () => ipcRenderer.invoke("desktop-setup:open-extension-folder")
});
