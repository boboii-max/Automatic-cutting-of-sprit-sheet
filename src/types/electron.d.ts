export interface DesktopImageFile {
  name: string;
  path: string;
  dataUrl: string;
}

export interface SaveSpritesheetInput {
  directory: string;
  filename: string;
  dataUrl: string;
}

export interface ElectronAPI {
  openImage: () => Promise<DesktopImageFile | null>;
  chooseExportDirectory: () => Promise<string | null>;
  saveSpritesheet: (input: SaveSpritesheetInput) => Promise<{ path: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
