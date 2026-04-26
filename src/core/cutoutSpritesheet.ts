import type {
  CutoutSprite,
  CutoutSpritesheetResult,
  CutoutSpritesheetSettings,
  PixelImageData,
  RGBColor
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeSettings(settings: CutoutSpritesheetSettings): CutoutSpritesheetSettings {
  return {
    cellWidth: Math.max(1, Math.round(settings.cellWidth)),
    cellHeight: Math.max(1, Math.round(settings.cellHeight)),
    columns: clamp(Math.round(settings.columns), 1, 12),
    resampleMode: settings.resampleMode
  };
}

function createTransparentImage(width: number, height: number): PixelImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
}

function getOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function readPixelClamped(image: PixelImageData, x: number, y: number): RGBColor {
  const nextX = clamp(x, 0, image.width - 1);
  const nextY = clamp(y, 0, image.height - 1);
  const offset = getOffset(image.width, nextX, nextY);
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    a: image.data[offset + 3]
  };
}

function writePixel(image: PixelImageData, x: number, y: number, color: RGBColor) {
  const offset = getOffset(image.width, x, y);
  image.data[offset] = color.r;
  image.data[offset + 1] = color.g;
  image.data[offset + 2] = color.b;
  image.data[offset + 3] = color.a;
}

function cubicWeight(value: number): number {
  const x = Math.abs(value);
  if (x <= 1) {
    return 1.5 * x * x * x - 2.5 * x * x + 1;
  }
  if (x < 2) {
    return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  }
  return 0;
}

function sampleNearest(image: PixelImageData, sourceX: number, sourceY: number): RGBColor {
  return readPixelClamped(image, Math.round(sourceX), Math.round(sourceY));
}

function sampleBicubic(image: PixelImageData, sourceX: number, sourceY: number): RGBColor {
  const baseX = Math.floor(sourceX);
  const baseY = Math.floor(sourceY);
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  let weightSum = 0;

  for (let y = baseY - 1; y <= baseY + 2; y += 1) {
    for (let x = baseX - 1; x <= baseX + 2; x += 1) {
      const weight = cubicWeight(sourceX - x) * cubicWeight(sourceY - y);
      if (weight === 0) {
        continue;
      }
      const color = readPixelClamped(image, x, y);
      red += color.r * weight;
      green += color.g * weight;
      blue += color.b * weight;
      alpha += color.a * weight;
      weightSum += weight;
    }
  }

  if (weightSum === 0) {
    return sampleNearest(image, sourceX, sourceY);
  }

  return {
    r: clamp(Math.round(red / weightSum), 0, 255),
    g: clamp(Math.round(green / weightSum), 0, 255),
    b: clamp(Math.round(blue / weightSum), 0, 255),
    a: clamp(Math.round(alpha / weightSum), 0, 255)
  };
}

function copyImage(source: PixelImageData, target: PixelImageData, targetX: number, targetY: number) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = getOffset(source.width, x, y);
      const targetOffset = getOffset(target.width, targetX + x, targetY + y);
      target.data[targetOffset] = source.data[sourceOffset];
      target.data[targetOffset + 1] = source.data[sourceOffset + 1];
      target.data[targetOffset + 2] = source.data[sourceOffset + 2];
      target.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
}

export function resampleCutoutToCell(
  image: PixelImageData,
  settings: CutoutSpritesheetSettings
): { image: PixelImageData; width: number; height: number; offsetX: number; offsetY: number } {
  const normalized = normalizeSettings(settings);
  if (image.width <= 0 || image.height <= 0) {
    throw new Error("无法重采样空图像。");
  }

  const scale = Math.min(normalized.cellWidth / image.width, normalized.cellHeight / image.height);
  const scaledWidth = Math.max(1, Math.round(image.width * scale));
  const scaledHeight = Math.max(1, Math.round(image.height * scale));
  const sampled = createTransparentImage(scaledWidth, scaledHeight);

  for (let y = 0; y < scaledHeight; y += 1) {
    for (let x = 0; x < scaledWidth; x += 1) {
      const sourceX = (x + 0.5) / scale - 0.5;
      const sourceY = (y + 0.5) / scale - 0.5;
      const color =
        normalized.resampleMode === "pixel"
          ? sampleNearest(image, sourceX, sourceY)
          : sampleBicubic(image, sourceX, sourceY);
      writePixel(sampled, x, y, color);
    }
  }

  return {
    image: sampled,
    width: scaledWidth,
    height: scaledHeight,
    offsetX: Math.floor((normalized.cellWidth - scaledWidth) / 2),
    offsetY: Math.floor((normalized.cellHeight - scaledHeight) / 2)
  };
}

export function buildCutoutSpritesheet(
  sprites: CutoutSprite[],
  settings: CutoutSpritesheetSettings
): CutoutSpritesheetResult {
  if (sprites.length === 0) {
    throw new Error("请先选择至少一个切图。");
  }

  const normalized = normalizeSettings(settings);
  const rows = Math.ceil(sprites.length / normalized.columns);
  const output = createTransparentImage(normalized.cellWidth * normalized.columns, normalized.cellHeight * rows);

  sprites.forEach((sprite, index) => {
    const column = index % normalized.columns;
    const row = Math.floor(index / normalized.columns);
    const resampled = resampleCutoutToCell(sprite.croppedImage, normalized);
    copyImage(
      resampled.image,
      output,
      column * normalized.cellWidth + resampled.offsetX,
      row * normalized.cellHeight + resampled.offsetY
    );
  });

  return {
    image: output,
    rows,
    columns: normalized.columns
  };
}
