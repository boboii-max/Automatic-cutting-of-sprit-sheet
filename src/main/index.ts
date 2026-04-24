import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1200,
    minHeight: 760,
    title: "Pixel Sprite Cuter",
    backgroundColor: "#e7dfcf",
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

  ipcMain.handle("save-spritesheet", async (_event, input) => {
    const filePath = path.join(input.directory, input.filename);
    const base64 = input.dataUrl.replace(/^data:image\/png;base64,/, "");
    await writeFile(filePath, Buffer.from(base64, "base64"));
    return { path: filePath };
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
