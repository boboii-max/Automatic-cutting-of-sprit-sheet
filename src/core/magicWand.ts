import type { MagicWandResult, MagicWandSettings, PixelImageData, RGBColor } from "./types";

interface ColorBucket {
  color: RGBColor;
  count: number;
}

const DEFAULT_SETTINGS: MagicWandSettings = {
  tolerance: 28,
  edgeSoftness: 32,
  edgeShrinkPixels: 1,
  sampleEdgeThickness: 2,
  maxBackgroundClusters: 3
};

const NEIGHBOR_4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1]
] as const;

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeSettings(settings: Partial<MagicWandSettings>): MagicWandSettings {
  return {
    tolerance: clamp(settings.tolerance ?? DEFAULT_SETTINGS.tolerance, 0, 220),
    edgeSoftness: clamp(settings.edgeSoftness ?? DEFAULT_SETTINGS.edgeSoftness, 0, 120),
    edgeShrinkPixels: clamp(Math.round(settings.edgeShrinkPixels ?? DEFAULT_SETTINGS.edgeShrinkPixels), 0, 4),
    sampleEdgeThickness: Math.max(1, Math.round(settings.sampleEdgeThickness ?? DEFAULT_SETTINGS.sampleEdgeThickness)),
    maxBackgroundClusters: clamp(
      Math.round(settings.maxBackgroundClusters ?? DEFAULT_SETTINGS.maxBackgroundClusters),
      1,
      3
    )
  };
}

function getIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

function getOffset(width: number, x: number, y: number): number {
  return getIndex(width, x, y) * 4;
}

function readColor(image: PixelImageData, x: number, y: number): RGBColor {
  const offset = getOffset(image.width, x, y);
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    a: image.data[offset + 3]
  };
}

function colorDistance(a: RGBColor, b: RGBColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function minBackgroundDistance(color: RGBColor, backgrounds: RGBColor[]): number {
  return backgrounds.reduce((best, background) => Math.min(best, colorDistance(color, background)), Number.POSITIVE_INFINITY);
}

function luminance(color: RGBColor): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function collectEdgeSamples(image: PixelImageData, thickness: number): RGBColor[] {
  const samples: RGBColor[] = [];
  const edgeThickness = Math.min(thickness, Math.ceil(Math.min(image.width, image.height) / 2));

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const isEdge =
        x < edgeThickness ||
        y < edgeThickness ||
        x >= image.width - edgeThickness ||
        y >= image.height - edgeThickness;
      if (!isEdge) {
        continue;
      }

      const color = readColor(image, x, y);
      if (color.a > 8) {
        samples.push(color);
      }
    }
  }

  if (samples.length === 0) {
    samples.push({ r: 255, g: 255, b: 255, a: 255 });
  }

  return samples;
}

function quantize(value: number): number {
  return clamp(Math.round(value / 12) * 12, 0, 255);
}

function clusterBackgroundColors(samples: RGBColor[], maxClusters: number): RGBColor[] {
  const buckets = new Map<string, ColorBucket>();

  samples.forEach((sample) => {
    const key = `${quantize(sample.r)},${quantize(sample.g)},${quantize(sample.b)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.color.r += sample.r;
      existing.color.g += sample.g;
      existing.color.b += sample.b;
      existing.color.a += sample.a;
      existing.count += 1;
      return;
    }

    buckets.set(key, {
      color: { ...sample },
      count: 1
    });
  });

  return Array.from(buckets.values())
    .map((bucket) => ({
      count: bucket.count,
      color: {
        r: Math.round(bucket.color.r / bucket.count),
        g: Math.round(bucket.color.g / bucket.count),
        b: Math.round(bucket.color.b / bucket.count),
        a: Math.round(bucket.color.a / bucket.count)
      }
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxClusters)
    .map((bucket) => bucket.color);
}

function isBackgroundLike(color: RGBColor, backgrounds: RGBColor[], tolerance: number): boolean {
  return color.a <= 8 || minBackgroundDistance(color, backgrounds) <= tolerance;
}

function shouldSeedPixel(image: PixelImageData, index: number, backgrounds: RGBColor[], tolerance: number): boolean {
  const offset = index * 4;
  return isBackgroundLike(
    {
      r: image.data[offset],
      g: image.data[offset + 1],
      b: image.data[offset + 2],
      a: image.data[offset + 3]
    },
    backgrounds,
    tolerance
  );
}

function collectEdgeSeeds(image: PixelImageData, backgrounds: RGBColor[], tolerance: number): number[] {
  const seeds: number[] = [];
  const { width, height } = image;

  for (let x = 0; x < width; x += 1) {
    const top = getIndex(width, x, 0);
    const bottom = getIndex(width, x, height - 1);
    if (shouldSeedPixel(image, top, backgrounds, tolerance)) {
      seeds.push(top);
    }
    if (bottom !== top && shouldSeedPixel(image, bottom, backgrounds, tolerance)) {
      seeds.push(bottom);
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    const left = getIndex(width, 0, y);
    const right = getIndex(width, width - 1, y);
    if (shouldSeedPixel(image, left, backgrounds, tolerance)) {
      seeds.push(left);
    }
    if (right !== left && shouldSeedPixel(image, right, backgrounds, tolerance)) {
      seeds.push(right);
    }
  }

  return seeds;
}

function floodFillEdgeBackground(image: PixelImageData, backgrounds: RGBColor[], tolerance: number): Uint8Array {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);
  const stack = collectEdgeSeeds(image, backgrounds, tolerance);

  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined || mask[index] === 1) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    const color = readColor(image, x, y);
    if (!isBackgroundLike(color, backgrounds, tolerance)) {
      continue;
    }

    mask[index] = 1;

    NEIGHBOR_4.forEach(([dx, dy]) => {
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
        return;
      }
      const nextIndex = getIndex(width, nextX, nextY);
      if (mask[nextIndex] === 0) {
        stack.push(nextIndex);
      }
    });
  }

  return mask;
}

function isTransparentAt(image: PixelImageData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return true;
  }
  return image.data[getOffset(image.width, x, y) + 3] <= 8;
}

function hasTransparentNeighbor(image: PixelImageData, x: number, y: number): boolean {
  return NEIGHBOR_8.some(([dx, dy]) => {
    const nextX = x + dx;
    const nextY = y + dy;
    return isTransparentAt(image, nextX, nextY);
  });
}

function hasSubjectNeighbor(
  image: PixelImageData,
  mask: Uint8Array,
  backgrounds: RGBColor[],
  tolerance: number,
  x: number,
  y: number
): boolean {
  const center = readColor(image, x, y);
  const centerLuminance = luminance(center);

  for (let yy = Math.max(0, y - 2); yy <= Math.min(image.height - 1, y + 2); yy += 1) {
    for (let xx = Math.max(0, x - 2); xx <= Math.min(image.width - 1, x + 2); xx += 1) {
      const index = getIndex(image.width, xx, yy);
      if (mask[index] === 1 || (xx === x && yy === y)) {
        continue;
      }

      const color = readColor(image, xx, yy);
      if (color.a <= 8) {
        continue;
      }

      const isClearlyForeground =
        minBackgroundDistance(color, backgrounds) > tolerance + 18 || luminance(color) < centerLuminance - 32;
      if (isClearlyForeground) {
        return true;
      }
    }
  }

  return false;
}

function softenConnectedMatte(
  image: PixelImageData,
  mask: Uint8Array,
  backgrounds: RGBColor[],
  settings: MagicWandSettings
): { image: PixelImageData; softenedPixelCount: number } {
  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  let softenedPixelCount = 0;

  if (settings.edgeSoftness <= 0) {
    return { image: output, softenedPixelCount };
  }

  const matteRange = settings.tolerance + settings.edgeSoftness * 1.8;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = getIndex(image.width, x, y);
      if (image.data[index * 4 + 3] <= 8 || !hasTransparentNeighbor(image, x, y)) {
        continue;
      }

      const color = readColor(image, x, y);
      if (color.a <= 8) {
        continue;
      }

      const distance = minBackgroundDistance(color, backgrounds);
      if (distance > matteRange || !hasSubjectNeighbor(image, mask, backgrounds, settings.tolerance, x, y)) {
        continue;
      }

      const strength = clamp((matteRange - distance) / Math.max(settings.edgeSoftness * 1.8, 1), 0, 1);
      const offset = index * 4;
      const nextAlpha = Math.round(output.data[offset + 3] * (1 - strength * 0.88));
      if (nextAlpha < output.data[offset + 3]) {
        output.data[offset + 3] = nextAlpha;
        softenedPixelCount += 1;
      }
    }
  }

  return { image: output, softenedPixelCount };
}

function isVisibleAt(image: PixelImageData, x: number, y: number): boolean {
  return image.data[getOffset(image.width, x, y) + 3] > 8;
}

function isAlphaEdgePixel(image: PixelImageData, x: number, y: number): boolean {
  if (!isVisibleAt(image, x, y)) {
    return false;
  }

  return NEIGHBOR_8.some(([dx, dy]) => isTransparentAt(image, x + dx, y + dy));
}

function shrinkVisibleEdges(image: PixelImageData, shrinkPixels: number): { image: PixelImageData; erodedPixelCount: number } {
  let current: PixelImageData = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  let erodedPixelCount = 0;

  for (let pass = 0; pass < shrinkPixels; pass += 1) {
    const nextData = new Uint8ClampedArray(current.data);
    let passCount = 0;

    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        if (!isAlphaEdgePixel(current, x, y)) {
          continue;
        }

        const offset = getOffset(current.width, x, y);
        nextData[offset + 3] = 0;
        passCount += 1;
      }
    }

    erodedPixelCount += passCount;
    current = {
      width: current.width,
      height: current.height,
      data: nextData
    };

    if (passCount === 0) {
      break;
    }
  }

  return { image: current, erodedPixelCount };
}

export function applyMagicWandCutout(
  image: PixelImageData,
  partialSettings: Partial<MagicWandSettings> = {}
): MagicWandResult {
  const settings = normalizeSettings(partialSettings);
  const backgroundColors = clusterBackgroundColors(
    collectEdgeSamples(image, settings.sampleEdgeThickness),
    settings.maxBackgroundClusters
  );
  const backgroundMask = floodFillEdgeBackground(image, backgroundColors, settings.tolerance);
  const baseOutput = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };

  let removedPixelCount = 0;
  backgroundMask.forEach((isBackground, index) => {
    if (isBackground === 0) {
      return;
    }
    const offset = index * 4;
    if (baseOutput.data[offset + 3] > 0) {
      removedPixelCount += 1;
    }
    baseOutput.data[offset + 3] = 0;
  });

  const shrunk = shrinkVisibleEdges(baseOutput, settings.edgeShrinkPixels);
  const softened = softenConnectedMatte(shrunk.image, backgroundMask, backgroundColors, settings);

  return {
    image: softened.image,
    backgroundColors,
    removedPixelCount,
    softenedPixelCount: softened.softenedPixelCount,
    erodedPixelCount: shrunk.erodedPixelCount
  };
}

export const defaultMagicWandSettings: MagicWandSettings = DEFAULT_SETTINGS;
