import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mindWeaverSetup", {
  loadState: () => ipcRenderer.invoke("desktop-setup:load-state"),
  submit: (payload) => ipcRenderer.invoke("desktop-setup:submit", payload),
  launchChrome: (payload) => ipcRenderer.invoke("desktop-setup:launch-chrome", payload),
  openExtensionFolder: () => ipcRenderer.invoke("desktop-setup:open-extension-folder"),
  copyText: (text) => ipcRenderer.invoke("desktop-setup:copy-text", text),
  addCodexConfig: () => ipcRenderer.invoke("desktop-setup:add-codex-config"),
  testAgentLauncher: () => ipcRenderer.invoke("desktop-setup:test-agent-launcher")
});
