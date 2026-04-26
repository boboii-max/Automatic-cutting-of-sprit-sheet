import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MessageBoxOptions } from "electron";
import type { SavePngFileInput, SavePngFilesInput, SaveSpritesheetInput } from "../types/electron";

const isDev = !app.isPackaged;

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function pngDataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(base64, "base64");
}

function ensurePngExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".png" ? filePath : `${filePath}.png`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 840,
    minHeight: 640,
    title: "2D 精灵表格导出",
    backgroundColor: "#101514",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    window.loadURL("http://localhost:5173");
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  return window;
}

app.whenReady().then(() => {
  ipcMain.handle("open-image", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const buffer = await readFile(filePath);
    const dataUrl = `data:${getMimeType(filePath)};base64,${buffer.toString("base64")}`;

    return {
      name: path.basename(filePath),
      path: filePath,
      dataUrl
    };
  });

  ipcMain.handle("choose-export-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("save-spritesheet", async (_event, input: SaveSpritesheetInput) => {
    const filePath = path.join(input.directory, input.filename);
    await writeFile(filePath, pngDataUrlToBuffer(input.dataUrl));
    return { path: filePath };
  });

  ipcMain.handle("save-png-file", async (_event, input: SavePngFileInput) => {
    const defaultFilename = input.defaultFilename.toLowerCase().endsWith(".png")
      ? input.defaultFilename
      : `${input.defaultFilename}.png`;
    const result = await dialog.showSaveDialog({
      defaultPath: defaultFilename,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const filePath = ensurePngExtension(result.filePath);
    await writeFile(filePath, pngDataUrlToBuffer(input.dataUrl));
    return { path: filePath };
  });

  ipcMain.handle("save-png-files", async (event, input: SavePngFilesInput) => {
    if (input.files.length === 0) {
      return null;
    }

    const defaultFilename = input.defaultFilename.toLowerCase().endsWith(".png")
      ? input.defaultFilename
      : `${input.defaultFilename}.png`;
    const result = await dialog.showSaveDialog({
      defaultPath: defaultFilename,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      properties: ["createDirectory"]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const basePath = ensurePngExtension(result.filePath);
    const parsedPath = path.parse(basePath);
    const filePaths = input.files.map((_file, index) => path.join(parsedPath.dir, `${parsedPath.name}_${index}.png`));
    const existingPaths: string[] = [];

    for (const filePath of filePaths) {
      if (await pathExists(filePath)) {
        existingPaths.push(filePath);
      }
    }

    if (existingPaths.length > 0) {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const messageBoxOptions: MessageBoxOptions = {
        type: "warning",
        buttons: ["取消", "覆盖"],
        defaultId: 0,
        cancelId: 0,
        title: "文件已存在",
        message: `将覆盖 ${existingPaths.length} 个已存在的 PNG 文件。`,
        detail: existingPaths.slice(0, 5).join("\n")
      };
      const confirmation = window
        ? await dialog.showMessageBox(window, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);

      if (confirmation.response !== 1) {
        return null;
      }
    }

    for (let index = 0; index < input.files.length; index += 1) {
      await writeFile(filePaths[index], pngDataUrlToBuffer(input.files[index].dataUrl));
    }

    return { paths: filePaths };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
