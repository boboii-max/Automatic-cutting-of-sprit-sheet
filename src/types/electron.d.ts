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

export interface SavePngFileInput {
  defaultFilename: string;
  dataUrl: string;
}

export interface SavePngFileItem {
  dataUrl: string;
}

export interface SavePngFilesInput {
  defaultFilename: string;
  files: SavePngFileItem[];
}

export interface ElectronAPI {
  openImage: () => Promise<DesktopImageFile | null>;
  chooseExportDirectory: () => Promise<string | null>;
  saveSpritesheet: (input: SaveSpritesheetInput) => Promise<{ path: string }>;
  savePngFile: (input: SavePngFileInput) => Promise<{ path: string } | null>;
  savePngFiles: (input: SavePngFilesInput) => Promise<{ paths: string[] } | null>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
