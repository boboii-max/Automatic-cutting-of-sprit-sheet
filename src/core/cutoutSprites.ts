import type { CutoutSprite, CutoutSpriteSettings, PixelImageData, Rect } from "./types";

const DEFAULT_SETTINGS: CutoutSpriteSettings = {
  alphaThreshold: 8,
  minArea: 8,
  minWidth: 2,
  minHeight: 2
};

const NEIGHBOR_8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
] as const;

function normalizeSettings(settings: Partial<CutoutSpriteSettings>): CutoutSpriteSettings {
  return {
    alphaThreshold: Math.max(0, Math.round(settings.alphaThreshold ?? DEFAULT_SETTINGS.alphaThreshold)),
    minArea: Math.max(1, Math.round(settings.minArea ?? DEFAULT_SETTINGS.minArea)),
    minWidth: Math.max(1, Math.round(settings.minWidth ?? DEFAULT_SETTINGS.minWidth)),
    minHeight: Math.max(1, Math.round(settings.minHeight ?? DEFAULT_SETTINGS.minHeight))
  };
}

function getIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function getOffset(width: number, x: number, y: number): number {
  return getIndex(width, x, y) * 4;
}

function isVisible(image: PixelImageData, index: number, alphaThreshold: number): boolean {
  return image.data[index * 4 + 3] > alphaThreshold;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRectToImage(image: PixelImageData, rect: Rect): Rect {
  const x = clamp(Math.round(rect.x), 0, Math.max(0, image.width - 1));
  const y = clamp(Math.round(rect.y), 0, Math.max(0, image.height - 1));
  const right = clamp(Math.round(rect.x + rect.width), x + 1, image.width);
  const bottom = clamp(Math.round(rect.y + rect.height), y + 1, image.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

export function cropImageByRect(image: PixelImageData, rect: Rect): PixelImageData {
  const bounds = normalizeRectToImage(image, rect);
  const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);

  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const sourceOffset = getOffset(image.width, bounds.x + x, bounds.y + y);
      const targetOffset = getOffset(bounds.width, x, y);
      data[targetOffset] = image.data[sourceOffset];
      data[targetOffset + 1] = image.data[sourceOffset + 1];
      data[targetOffset + 2] = image.data[sourceOffset + 2];
      data[targetOffset + 3] = image.data[sourceOffset + 3];
    }
  }

  return {
    width: bounds.width,
    height: bounds.height,
    data
  };
}

export function calculateVisibleArea(image: PixelImageData, rect: Rect, alphaThreshold = 8): number {
  const bounds = normalizeRectToImage(image, rect);
  let area = 0;

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const index = getIndex(image.width, x, y);
      if (isVisible(image, index, alphaThreshold)) {
        area += 1;
      }
    }
  }

  return area;
}

export function isRectFullyContained(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function cropComponent(image: PixelImageData, pixels: number[], bounds: CutoutSprite["bounds"]): PixelImageData {
  const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);

  pixels.forEach((index) => {
    const sourceX = index % image.width;
    const sourceY = Math.floor(index / image.width);
    const targetX = sourceX - bounds.x;
    const targetY = sourceY - bounds.y;
    const sourceOffset = getOffset(image.width, sourceX, sourceY);
    const targetOffset = getOffset(bounds.width, targetX, targetY);
    data[targetOffset] = image.data[sourceOffset];
    data[targetOffset + 1] = image.data[sourceOffset + 1];
    data[targetOffset + 2] = image.data[sourceOffset + 2];
    data[targetOffset + 3] = image.data[sourceOffset + 3];
  });

  return {
    width: bounds.width,
    height: bounds.height,
    data
  };
}

export function extractCutoutSprites(
  image: PixelImageData,
  partialSettings: Partial<CutoutSpriteSettings> = {}
): CutoutSprite[] {
  const settings = normalizeSettings(partialSettings);
  const visited = new Uint8Array(image.width * image.height);
  const sprites: CutoutSprite[] = [];

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const startIndex = getIndex(image.width, x, y);
      if (visited[startIndex] === 1 || !isVisible(image, startIndex, settings.alphaThreshold)) {
        continue;
      }

      const stack = [startIndex];
      const pixels: number[] = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      visited[startIndex] = 1;

      while (stack.length > 0) {
        const index = stack.pop();
        if (index === undefined) {
          continue;
        }

        const currentX = index % image.width;
        const currentY = Math.floor(index / image.width);
        pixels.push(index);
        minX = Math.min(minX, currentX);
        minY = Math.min(minY, currentY);
        maxX = Math.max(maxX, currentX);
        maxY = Math.max(maxY, currentY);

        NEIGHBOR_8.forEach(([dx, dy]) => {
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (nextX < 0 || nextY < 0 || nextX >= image.width || nextY >= image.height) {
            return;
          }

          const nextIndex = getIndex(image.width, nextX, nextY);
          if (visited[nextIndex] === 1 || !isVisible(image, nextIndex, settings.alphaThreshold)) {
            return;
          }

          visited[nextIndex] = 1;
          stack.push(nextIndex);
        });
      }

      const bounds = {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      };

      if (
        pixels.length < settings.minArea ||
        bounds.width < settings.minWidth ||
        bounds.height < settings.minHeight
      ) {
        continue;
      }

      sprites.push({
        id: `cut-${String(sprites.length + 1).padStart(3, "0")}`,
        bounds,
        width: bounds.width,
        height: bounds.height,
        area: pixels.length,
        order: sprites.length,
        croppedImage: cropComponent(image, pixels, bounds)
      });
    }
  }

  return sprites.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}
