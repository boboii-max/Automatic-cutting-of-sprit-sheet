import { contextBridge, ipcRenderer } from "electron";
import type { DesktopImageFile, SaveSpritesheetInput } from "../types/electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openImage: (): Promise<DesktopImageFile | null> => ipcRenderer.invoke("open-image"),
  chooseExportDirectory: (): Promise<string | null> => ipcRenderer.invoke("choose-export-directory"),
  saveSpritesheet: (input: SaveSpritesheetInput): Promise<{ path: string }> =>
    ipcRenderer.invoke("save-spritesheet", input)
});
