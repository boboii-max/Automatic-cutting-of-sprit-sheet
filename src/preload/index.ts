import { contextBridge, ipcRenderer } from "electron";
import type { DesktopImageFile, SavePngFileInput, SavePngFilesInput, SaveSpritesheetInput } from "../types/electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openImage: (): Promise<DesktopImageFile | null> => ipcRenderer.invoke("open-image"),
  chooseExportDirectory: (): Promise<string | null> => ipcRenderer.invoke("choose-export-directory"),
  saveSpritesheet: (input: SaveSpritesheetInput): Promise<{ path: string }> =>
    ipcRenderer.invoke("save-spritesheet", input),
  savePngFile: (input: SavePngFileInput): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("save-png-file", input),
  savePngFiles: (input: SavePngFilesInput): Promise<{ paths: string[] } | null> =>
    ipcRenderer.invoke("save-png-files", input)
});
