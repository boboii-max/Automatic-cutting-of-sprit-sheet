import type { CSSProperties } from "react";
import type { PixelImageData } from "../core/types";

export async function dataUrlToPixelImage(dataUrl: string): Promise<PixelImageData> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建图片读取画布。");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data)
  };
}

export async function pixelImageToDataUrl(image: PixelImageData): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建导出画布。");
  }
  context.imageSmoothingEnabled = false;
  const imageData = new ImageData(image.data, image.width, image.height);
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

export function rectToStyle(
  naturalWidth: number,
  naturalHeight: number,
  displayWidth: number,
  displayHeight: number,
  rect: { x: number; y: number; width: number; height: number }
): CSSProperties {
  const scaleX = displayWidth / naturalWidth;
  const scaleY = displayHeight / naturalHeight;
  return {
    left: `${rect.x * scaleX}px`,
    top: `${rect.y * scaleY}px`,
    width: `${rect.width * scaleX}px`,
    height: `${rect.height * scaleY}px`
  };
}
