import { colorDistance } from "./detection";
import type {
  DetectedSprite,
  ExportOptions,
  PixelImageData,
  RGBColor,
  SpriteGroup
} from "./types";

export interface ExportLayoutResult {
  image: PixelImageData;
  rows: number;
  columns: number;
}

export interface ExportValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ResampledSprite {
  sprite: DetectedSprite;
  image: PixelImageData;
  width: number;
  height: number;
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  edgeCleanupMode: "standard"
};
const STANDARD_BACKGROUND_THRESHOLD = 62;
const STRONG_OUTLINE_RING_LIMIT = 3;
const STRONG_TRIM_RING_LIMIT = 2;
const STRONG_DECONTAMINATION_RADIUS = 4;
const STRONG_MIN_INTERIOR_BRIGHTNESS = 22;
const STRONG_MAX_INTERIOR_BRIGHTNESS = 210;
const STRONG_MATTE_BRIGHTNESS = 140;
const STRONG_MATTE_SATURATION = 92;
const STRONG_MATTE_BACKGROUND_DISTANCE = 148;
const STRONG_TRIM_BACKGROUND_DISTANCE = 92;
const STRONG_TRIM_BRIGHTNESS = 188;
const STRONG_TRIM_SATURATION = 84;

function createTransparentImage(width: number, height: number): PixelImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
}

function getPixelOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function readPixel(image: PixelImageData, x: number, y: number): RGBColor {
  const offset = getPixelOffset(image.width, x, y);
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    a: image.data[offset + 3]
  };
}

function writePixel(
  image: PixelImageData,
  x: number,
  y: number,
  color: Partial<RGBColor> & Pick<RGBColor, "a">
) {
  const offset = getPixelOffset(image.width, x, y);
  if (color.r !== undefined) {
    image.data[offset] = color.r;
  }
  if (color.g !== undefined) {
    image.data[offset + 1] = color.g;
  }
  if (color.b !== undefined) {
    image.data[offset + 2] = color.b;
  }
  image.data[offset + 3] = color.a;
}

function clearPixel(image: PixelImageData, x: number, y: number) {
  writePixel(image, x, y, { r: 0, g: 0, b: 0, a: 0 });
}

function hasVisibleNeighbor(image: PixelImageData, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
        continue;
      }
      const offset = getPixelOffset(image.width, nx, ny);
      if (image.data[offset + 3] > 0) {
        return true;
      }
    }
  }
  return false;
}

function isEdgeForegroundPixel(image: PixelImageData, x: number, y: number): boolean {
  if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
    return true;
  }

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      const offset = getPixelOffset(image.width, nx, ny);
      if (image.data[offset + 3] === 0) {
        return true;
      }
    }
  }

  return false;
}

function countVisiblePixels(image: PixelImageData): number {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 0) {
      count += 1;
    }
  }
  return count;
}

function getBrightness(color: RGBColor): number {
  return Math.round((color.r + color.g + color.b) / 3);
}

function getSaturation(color: RGBColor): number {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
}

function isVisiblePixel(image: PixelImageData, x: number, y: number): boolean {
  return image.data[getPixelOffset(image.width, x, y) + 3] > 0;
}

function isNearBackground(
  image: PixelImageData,
  x: number,
  y: number,
  threshold: number,
  background: DetectedSprite["backgroundColor"]
): boolean {
  const offset = getPixelOffset(image.width, x, y);
  return (
    colorDistance(
      {
        r: image.data[offset],
        g: image.data[offset + 1],
        b: image.data[offset + 2],
        a: image.data[offset + 3]
      },
      background
    ) <= threshold
  );
}

export function cleanSpriteEdges(sprite: DetectedSprite): PixelImageData {
  const source = sprite.croppedImage;
  const cleaned: PixelImageData = {
    width: source.width,
    height: source.height,
    data: new Uint8ClampedArray(source.data)
  };

  for (let y = 0; y < cleaned.height; y += 1) {
    for (let x = 0; x < cleaned.width; x += 1) {
      const offset = getPixelOffset(source.width, x, y);
      if (source.data[offset + 3] === 0) {
        continue;
      }
      if (!isEdgeForegroundPixel(source, x, y)) {
        continue;
      }
      if (!isNearBackground(source, x, y, STANDARD_BACKGROUND_THRESHOLD, sprite.backgroundColor)) {
        continue;
      }
      if (!hasVisibleNeighbor(source, x, y) && x !== 0 && y !== 0 && x !== source.width - 1 && y !== source.height - 1) {
        continue;
      }
      cleaned.data[offset] = 0;
      cleaned.data[offset + 1] = 0;
      cleaned.data[offset + 2] = 0;
      cleaned.data[offset + 3] = 0;
    }
  }

  return cleaned;
}

function collectOutlineRings(image: PixelImageData, maxRing: number): Uint8Array {
  const rings = new Uint8Array(image.width * image.height);
  const working = new Uint8Array(image.width * image.height);

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isVisiblePixel(image, x, y)) {
        working[y * image.width + x] = 1;
      }
    }
  }

  const isWorkingVisible = (x: number, y: number) => working[y * image.width + x] === 1;
  const isWorkingEdge = (x: number, y: number): boolean => {
    if (!isWorkingVisible(x, y)) {
      return false;
    }
    if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
      return true;
    }
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        if (!isWorkingVisible(x + dx, y + dy)) {
          return true;
        }
      }
    }
    return false;
  };

  for (let ring = 1; ring <= maxRing; ring += 1) {
    const toClear: number[] = [];
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = y * image.width + x;
        if (!isWorkingVisible(x, y) || rings[index] !== 0) {
          continue;
        }
        if (isWorkingEdge(x, y)) {
          rings[index] = ring;
          toClear.push(index);
        }
      }
    }
    toClear.forEach((index) => {
      working[index] = 0;
    });
  }

  return rings;
}

function findRepresentativeInteriorColor(
  image: PixelImageData,
  rings: Uint8Array,
  x: number,
  y: number,
  backgroundColor: DetectedSprite["backgroundColor"]
): RGBColor | null {
  let weightSum = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let dy = -STRONG_DECONTAMINATION_RADIUS; dy <= STRONG_DECONTAMINATION_RADIUS; dy += 1) {
    for (let dx = -STRONG_DECONTAMINATION_RADIUS; dx <= STRONG_DECONTAMINATION_RADIUS; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
        continue;
      }
      if (!isVisiblePixel(image, nx, ny)) {
        continue;
      }
      const index = ny * image.width + nx;
      if (rings[index] !== 0 && rings[index] <= STRONG_OUTLINE_RING_LIMIT) {
        continue;
      }

      const color = readPixel(image, nx, ny);
      const brightness = getBrightness(color);
      if (
        brightness < STRONG_MIN_INTERIOR_BRIGHTNESS ||
        brightness > STRONG_MAX_INTERIOR_BRIGHTNESS ||
        colorDistance(color, backgroundColor) <= STANDARD_BACKGROUND_THRESHOLD
      ) {
        continue;
      }

      const distance = Math.sqrt(dx * dx + dy * dy);
      const weight = 1 / Math.max(distance, 1);
      red += color.r * weight;
      green += color.g * weight;
      blue += color.b * weight;
      weightSum += weight;
    }
  }

  if (weightSum === 0) {
    return null;
  }

  return {
    r: Math.round(red / weightSum),
    g: Math.round(green / weightSum),
    b: Math.round(blue / weightSum),
    a: 255
  };
}

function decontaminateWhiteMatte(sprite: DetectedSprite, image: PixelImageData, rings: Uint8Array): PixelImageData {
  const output: PixelImageData = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      if (!isVisiblePixel(image, x, y) || rings[index] === 0 || rings[index] > STRONG_OUTLINE_RING_LIMIT) {
        continue;
      }

      const color = readPixel(image, x, y);
      if (
        getBrightness(color) < STRONG_MATTE_BRIGHTNESS ||
        getSaturation(color) > STRONG_MATTE_SATURATION ||
        colorDistance(color, sprite.backgroundColor) > STRONG_MATTE_BACKGROUND_DISTANCE
      ) {
        continue;
      }

      const interior = findRepresentativeInteriorColor(image, rings, x, y, sprite.backgroundColor);
      if (!interior) {
        continue;
      }

      const blendRatio = rings[index] === 1 ? 0.82 : rings[index] === 2 ? 0.68 : 0.54;
      writePixel(output, x, y, {
        r: Math.round(color.r * (1 - blendRatio) + interior.r * blendRatio),
        g: Math.round(color.g * (1 - blendRatio) + interior.g * blendRatio),
        b: Math.round(color.b * (1 - blendRatio) + interior.b * blendRatio),
        a:
          colorDistance(color, sprite.backgroundColor) <= STANDARD_BACKGROUND_THRESHOLD
            ? Math.max(176, Math.round(color.a * 0.88))
            : color.a
      });
    }
  }

  return output;
}

function trimResidualHalo(sprite: DetectedSprite, image: PixelImageData, rings: Uint8Array): PixelImageData {
  const output: PixelImageData = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      if (!isVisiblePixel(image, x, y) || rings[index] === 0 || rings[index] > STRONG_TRIM_RING_LIMIT) {
        continue;
      }

      const color = readPixel(image, x, y);
      if (
        getBrightness(color) >= STRONG_TRIM_BRIGHTNESS &&
        getSaturation(color) <= STRONG_TRIM_SATURATION &&
        colorDistance(color, sprite.backgroundColor) <= STRONG_TRIM_BACKGROUND_DISTANCE
      ) {
        clearPixel(output, x, y);
      }
    }
  }

  return output;
}

export function prepareSpriteForExport(
  sprite: DetectedSprite,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): PixelImageData {
  if (options.edgeCleanupMode === "outline_strong") {
    const rings = collectOutlineRings(sprite.croppedImage, STRONG_OUTLINE_RING_LIMIT);
    const decontaminated = decontaminateWhiteMatte(sprite, sprite.croppedImage, rings);
    return trimResidualHalo(sprite, decontaminated, rings);
  }

  return cleanSpriteEdges(sprite);
}

function getVisibleBounds(image: PixelImageData): { width: number; height: number } {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = getPixelOffset(image.width, x, y);
      if (image.data[offset + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return { width: 0, height: 0 };
  }

  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function sampleNearest(image: PixelImageData, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ];
}

export function resampleSpriteToGroup(
  sprite: DetectedSprite,
  group: SpriteGroup,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): ResampledSprite {
  if (group.cellWidth <= 0 || group.cellHeight <= 0) {
    throw new Error(`目标分组 ${group.label} 的尺寸无效。`);
  }

  if (sprite.width <= 0 || sprite.height <= 0) {
    throw new Error(`${sprite.id} 的尺寸无效。`);
  }

  const cleanedImage = prepareSpriteForExport(sprite, options);
  if (countVisiblePixels(cleanedImage) === 0) {
    throw new Error(`${sprite.id} 边缘净化后无有效像素。`);
  }

  const cleanedBounds = getVisibleBounds(cleanedImage);
  const sourceWidth = cleanedBounds.width || sprite.width;
  const sourceHeight = cleanedBounds.height || sprite.height;
  const containScale = Math.min(group.cellWidth / sourceWidth, group.cellHeight / sourceHeight);
  const scale = group.allowUpscale ? containScale : Math.min(containScale, 1);
  const targetWidth = Math.max(1, Math.min(group.cellWidth, Math.round(sourceWidth * scale)));
  const targetHeight = Math.max(1, Math.min(group.cellHeight, Math.round(sourceHeight * scale)));
  const image = createTransparentImage(targetWidth, targetHeight);

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        cleanedImage.width - 1,
        Math.floor((x / targetWidth) * cleanedImage.width)
      );
      const sourceY = Math.min(
        cleanedImage.height - 1,
        Math.floor((y / targetHeight) * cleanedImage.height)
      );
      const [r, g, b, a] = sampleNearest(cleanedImage, sourceX, sourceY);
      const targetOffset = (y * targetWidth + x) * 4;
      image.data[targetOffset] = r;
      image.data[targetOffset + 1] = g;
      image.data[targetOffset + 2] = b;
      image.data[targetOffset + 3] = a;
    }
  }

  return {
    sprite,
    image,
    width: targetWidth,
    height: targetHeight
  };
}

function drawSprite(
  target: PixelImageData,
  sprite: PixelImageData,
  offsetX: number,
  offsetY: number
): void {
  const { width, height, data } = sprite;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const alpha = data[sourceOffset + 3];
      if (alpha === 0) {
        continue;
      }
      const targetOffset = ((offsetY + y) * target.width + (offsetX + x)) * 4;
      target.data[targetOffset] = data[sourceOffset];
      target.data[targetOffset + 1] = data[sourceOffset + 1];
      target.data[targetOffset + 2] = data[sourceOffset + 2];
      target.data[targetOffset + 3] = alpha;
    }
  }
}

export function validateSpritesForGroup(
  sprites: DetectedSprite[],
  group: SpriteGroup,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): ExportValidationResult {
  const errors: string[] = [];

  if (group.cellWidth <= 0 || group.cellHeight <= 0) {
    errors.push(`分组 ${group.label} 的目标尺寸无效。`);
  }

  if (group.columnCount <= 0) {
    errors.push(`分组 ${group.label} 的列数无效。`);
  }

  if (sprites.length === 0) {
    errors.push(`分组 ${group.label} 没有可导出的精灵。`);
  }

  sprites.forEach((sprite) => {
    if (sprite.width <= 0 || sprite.height <= 0) {
      errors.push(`${sprite.id} 的原始尺寸无效。`);
      return;
    }

    try {
      const resampled = resampleSpriteToGroup(sprite, group, options);
      if (resampled.width <= 0 || resampled.height <= 0) {
        errors.push(`${sprite.id} 重采样后尺寸无效。`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : `${sprite.id} 重采样失败。`;
      errors.push(text);
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

export function buildSpritesheet(
  sprites: DetectedSprite[],
  group: SpriteGroup,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): ExportLayoutResult {
  const rows = Math.max(1, Math.ceil(sprites.length / group.columnCount));
  const columns = Math.max(1, group.columnCount);
  const image: PixelImageData = {
    width: columns * group.cellWidth,
    height: rows * group.cellHeight,
    data: new Uint8ClampedArray(columns * group.cellWidth * rows * group.cellHeight * 4)
  };

  sprites.forEach((sprite, index) => {
    const resampled = resampleSpriteToGroup(sprite, group, options);
    const col = index % columns;
    const row = Math.floor(index / columns);
    const offsetX = col * group.cellWidth + Math.floor((group.cellWidth - resampled.width) / 2);
    const offsetY = row * group.cellHeight + Math.floor((group.cellHeight - resampled.height) / 2);
    drawSprite(image, resampled.image, offsetX, offsetY);
  });

  return { image, rows, columns };
}
