import type { DetectedSprite, DetectionSettings, PixelImageData, RGBColor } from "./types";

const EDGE_QUANTIZE_STEP = 8;
const SUBJECT_EDGE_BACKGROUND_THRESHOLD = 70;
const NEARBY_COMPONENT_AREA_RATIO = 0.03;
const MIN_NEARBY_COMPONENT_AREA = 1;
const MAX_NEARBY_COMPONENT_GAP = 2;
const WHITE_FRINGE_BRIGHTNESS_THRESHOLD = 176;
const WHITE_FRINGE_MAX_SATURATION = 42;
const WHITE_FRINGE_BACKGROUND_DISTANCE_THRESHOLD = 104;
const DARK_INTERIOR_BRIGHTNESS_THRESHOLD = 118;
const WHITE_FRINGE_DIRECT_SEARCH_RADIUS = 1;
const WHITE_FRINGE_NEARBY_SEARCH_RADIUS = 2;
const WHITE_FRINGE_AGGRESSIVE_SEARCH_RADIUS = 3;
const THIN_BRIGHT_EDGE_MAX_VISIBLE_NEIGHBORS = 3;
const THIN_BRIGHT_EDGE_MAX_RUN_LENGTH = 6;
const AGGRESSIVE_WHITE_FRINGE_BRIGHTNESS_THRESHOLD = 152;
const AGGRESSIVE_WHITE_FRINGE_MAX_SATURATION = 72;
const AGGRESSIVE_WHITE_FRINGE_BACKGROUND_DISTANCE_THRESHOLD = 132;
const WHITE_FRINGE_MAX_PASSES = 4;

function getOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function readColor(image: PixelImageData, x: number, y: number): RGBColor {
  const offset = getOffset(image.width, x, y);
  const { data } = image;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
    a: data[offset + 3]
  };
}

function hasVisiblePixel(image: PixelImageData, x: number, y: number): boolean {
  return image.data[getOffset(image.width, x, y) + 3] > 0;
}

function getPixelColor(image: PixelImageData, x: number, y: number): RGBColor {
  return readColor(image, x, y);
}

function getBrightness(color: RGBColor): number {
  return Math.round((color.r + color.g + color.b) / 3);
}

function getSaturation(color: RGBColor): number {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
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
      if (!hasVisiblePixel(image, x + dx, y + dy)) {
        return true;
      }
    }
  }

  return false;
}

function createTransparentImage(width: number, height: number): PixelImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
}

function copyPixel(
  source: PixelImageData,
  target: PixelImageData,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number
) {
  const sourceOffset = getOffset(source.width, sourceX, sourceY);
  const targetOffset = getOffset(target.width, targetX, targetY);
  target.data[targetOffset] = source.data[sourceOffset];
  target.data[targetOffset + 1] = source.data[sourceOffset + 1];
  target.data[targetOffset + 2] = source.data[sourceOffset + 2];
  target.data[targetOffset + 3] = source.data[sourceOffset + 3];
}

function clearPixel(image: PixelImageData, x: number, y: number) {
  const offset = getOffset(image.width, x, y);
  image.data[offset] = 0;
  image.data[offset + 1] = 0;
  image.data[offset + 2] = 0;
  image.data[offset + 3] = 0;
}

interface ComponentInfo {
  pixels: Array<{ x: number; y: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
}

function extractSubcomponents(image: PixelImageData): ComponentInfo[] {
  const visited = new Uint8Array(image.width * image.height);
  const components: ComponentInfo[] = [];
  const neighbors = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1]
  ];

  const markVisited = (x: number, y: number) => {
    visited[y * image.width + x] = 1;
  };

  const wasVisited = (x: number, y: number) => visited[y * image.width + x] === 1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (wasVisited(x, y) || !hasVisiblePixel(image, x, y)) {
        continue;
      }

      const stack = [{ x, y }];
      const pixels: Array<{ x: number; y: number }> = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      markVisited(x, y);

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          break;
        }

        pixels.push(current);
        minX = Math.min(minX, current.x);
        minY = Math.min(minY, current.y);
        maxX = Math.max(maxX, current.x);
        maxY = Math.max(maxY, current.y);

        for (const [dx, dy] of neighbors) {
          const nextX = current.x + dx;
          const nextY = current.y + dy;
          if (
            nextX < 0 ||
            nextY < 0 ||
            nextX >= image.width ||
            nextY >= image.height ||
            wasVisited(nextX, nextY) ||
            !hasVisiblePixel(image, nextX, nextY)
          ) {
            continue;
          }
          markVisited(nextX, nextY);
          stack.push({ x: nextX, y: nextY });
        }
      }

      components.push({
        pixels,
        area: pixels.length,
        bounds: { minX, minY, maxX, maxY }
      });
    }
  }

  return components;
}

function getBoundsGap(a: ComponentInfo["bounds"], b: ComponentInfo["bounds"]): number {
  const horizontalGap = Math.max(0, Math.max(a.minX - b.maxX - 1, b.minX - a.maxX - 1));
  const verticalGap = Math.max(0, Math.max(a.minY - b.maxY - 1, b.minY - a.maxY - 1));
  return Math.max(horizontalGap, verticalGap);
}

function buildSubjectCandidateMask(image: PixelImageData, backgroundColor: RGBColor): PixelImageData {
  const mask = createTransparentImage(image.width, image.height);

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!hasVisiblePixel(image, x, y)) {
        continue;
      }

      const color = readColor(image, x, y);
      const shouldDiscard =
        isEdgeForegroundPixel(image, x, y) &&
        colorDistance(color, backgroundColor) <= SUBJECT_EDGE_BACKGROUND_THRESHOLD;

      if (!shouldDiscard) {
        copyPixel(image, mask, x, y, x, y);
      }
    }
  }

  return mask;
}

function cropToVisiblePixels(image: PixelImageData): {
  image: PixelImageData;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  area: number;
} {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!hasVisiblePixel(image, x, y)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area += 1;
    }
  }

  if (area === 0 || maxX < minX || maxY < minY) {
    return {
      image,
      offsetX: 0,
      offsetY: 0,
      width: image.width,
      height: image.height,
      area: 0
    };
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = createTransparentImage(width, height);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!hasVisiblePixel(image, x, y)) {
        continue;
      }
      copyPixel(image, cropped, x, y, x - minX, y - minY);
    }
  }

  return {
    image: cropped,
    offsetX: minX,
    offsetY: minY,
    width,
    height,
    area
  };
}

export function refineSpriteSubject(sprite: Pick<DetectedSprite, "croppedImage" | "backgroundColor">): {
  image: PixelImageData;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  area: number;
} {
  const candidateMask = buildSubjectCandidateMask(sprite.croppedImage, sprite.backgroundColor);
  const components = extractSubcomponents(candidateMask);

  if (components.length === 0) {
    return cropToVisiblePixels(sprite.croppedImage);
  }

  components.sort((a, b) => b.area - a.area);
  const core = components[0];
  const minNearbyArea = Math.max(MIN_NEARBY_COMPONENT_AREA, Math.round(core.area * NEARBY_COMPONENT_AREA_RATIO));
  const keptComponents = components.filter((component, index) => {
    if (index === 0) {
      return true;
    }
    return component.area >= minNearbyArea && getBoundsGap(component.bounds, core.bounds) <= MAX_NEARBY_COMPONENT_GAP;
  });

  const refinedMask = createTransparentImage(sprite.croppedImage.width, sprite.croppedImage.height);
  for (const component of keptComponents) {
    for (const pixel of component.pixels) {
      copyPixel(sprite.croppedImage, refinedMask, pixel.x, pixel.y, pixel.x, pixel.y);
    }
  }

  return cropToVisiblePixels(refinedMask);
}

function hasDarkInteriorNeighbor(
  image: PixelImageData,
  x: number,
  y: number,
  searchRadius = WHITE_FRINGE_DIRECT_SEARCH_RADIUS
): boolean {
  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
        continue;
      }
      if (!hasVisiblePixel(image, nx, ny)) {
        continue;
      }
      const neighborColor = getPixelColor(image, nx, ny);
      if (getBrightness(neighborColor) <= DARK_INTERIOR_BRIGHTNESS_THRESHOLD) {
        return true;
      }
    }
  }

  return false;
}

function countVisibleNeighbors(image: PixelImageData, x: number, y: number): number {
  let count = 0;

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
      if (hasVisiblePixel(image, nx, ny)) {
        count += 1;
      }
    }
  }

  return count;
}

function isBrightBackgroundLike(color: RGBColor, backgroundColor: RGBColor): boolean {
  return (
    getBrightness(color) >= WHITE_FRINGE_BRIGHTNESS_THRESHOLD &&
    getSaturation(color) <= WHITE_FRINGE_MAX_SATURATION &&
    colorDistance(color, backgroundColor) <= WHITE_FRINGE_BACKGROUND_DISTANCE_THRESHOLD
  );
}

function isAggressiveBrightBackgroundLike(color: RGBColor, backgroundColor: RGBColor): boolean {
  return (
    getBrightness(color) >= AGGRESSIVE_WHITE_FRINGE_BRIGHTNESS_THRESHOLD &&
    getSaturation(color) <= AGGRESSIVE_WHITE_FRINGE_MAX_SATURATION &&
    colorDistance(color, backgroundColor) <= AGGRESSIVE_WHITE_FRINGE_BACKGROUND_DISTANCE_THRESHOLD
  );
}

function getBrightRunLength(
  image: PixelImageData,
  x: number,
  y: number,
  dx: number,
  dy: number,
  backgroundColor: RGBColor
): number {
  let length = 1;

  for (const direction of [-1, 1]) {
    let step = 1;
    while (step <= THIN_BRIGHT_EDGE_MAX_RUN_LENGTH) {
      const nx = x + dx * step * direction;
      const ny = y + dy * step * direction;
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
        break;
      }
      if (!hasVisiblePixel(image, nx, ny)) {
        break;
      }
      if (!isBrightBackgroundLike(getPixelColor(image, nx, ny), backgroundColor)) {
        break;
      }
      length += 1;
      step += 1;
    }
  }

  return length;
}

function isThinBrightEdge(image: PixelImageData, x: number, y: number, backgroundColor: RGBColor): boolean {
  const visibleNeighbors = countVisibleNeighbors(image, x, y);
  if (visibleNeighbors > THIN_BRIGHT_EDGE_MAX_VISIBLE_NEIGHBORS) {
    return false;
  }

  const horizontalRun = getBrightRunLength(image, x, y, 1, 0, backgroundColor);
  const verticalRun = getBrightRunLength(image, x, y, 0, 1, backgroundColor);
  return (
    horizontalRun <= THIN_BRIGHT_EDGE_MAX_RUN_LENGTH || verticalRun <= THIN_BRIGHT_EDGE_MAX_RUN_LENGTH
  );
}

function shouldRemoveBrightFringe(
  image: PixelImageData,
  x: number,
  y: number,
  backgroundColor: RGBColor
): boolean {
  if (!hasVisiblePixel(image, x, y) || !isEdgeForegroundPixel(image, x, y)) {
    return false;
  }

  const color = getPixelColor(image, x, y);
  if (!isBrightBackgroundLike(color, backgroundColor)) {
    return false;
  }

  if (hasDarkInteriorNeighbor(image, x, y, WHITE_FRINGE_DIRECT_SEARCH_RADIUS)) {
    return true;
  }

  return (
    isThinBrightEdge(image, x, y, backgroundColor) &&
    hasDarkInteriorNeighbor(image, x, y, WHITE_FRINGE_NEARBY_SEARCH_RADIUS)
  );
}

function isWhiteFringePixel(image: PixelImageData, x: number, y: number, backgroundColor: RGBColor): boolean {
  return shouldRemoveBrightFringe(image, x, y, backgroundColor);
}

function shouldPeelAggressiveFringe(
  image: PixelImageData,
  x: number,
  y: number,
  backgroundColor: RGBColor
): boolean {
  if (!hasVisiblePixel(image, x, y) || !isEdgeForegroundPixel(image, x, y)) {
    return false;
  }

  const color = getPixelColor(image, x, y);
  if (!isAggressiveBrightBackgroundLike(color, backgroundColor)) {
    return false;
  }

  return (
    hasDarkInteriorNeighbor(image, x, y, WHITE_FRINGE_AGGRESSIVE_SEARCH_RADIUS) ||
    (isThinBrightEdge(image, x, y, backgroundColor) &&
      hasDarkInteriorNeighbor(image, x, y, WHITE_FRINGE_NEARBY_SEARCH_RADIUS))
  );
}

function peelBoundaryWhiteFringe(image: PixelImageData, backgroundColor: RGBColor): boolean {
  const candidatePixels: Array<{ x: number; y: number }> = [];
  let changed = false;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!shouldPeelAggressiveFringe(image, x, y, backgroundColor)) {
        continue;
      }
      candidatePixels.push({ x, y });
    }
  }

  for (const pixel of candidatePixels) {
    clearPixel(image, pixel.x, pixel.y);
    changed = true;
  }

  return changed;
}

export function removeWhiteFringe(sprite: Pick<DetectedSprite, "croppedImage" | "backgroundColor">): {
  image: PixelImageData;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  area: number;
} {
  const source = sprite.croppedImage;
  const cleaned = createTransparentImage(source.width, source.height);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (!hasVisiblePixel(source, x, y)) {
        continue;
      }
      copyPixel(source, cleaned, x, y, x, y);
    }
  }

  for (let pass = 0; pass < WHITE_FRINGE_MAX_PASSES; pass += 1) {
    const changed = peelBoundaryWhiteFringe(cleaned, sprite.backgroundColor);
    if (!changed) {
      break;
    }
  }

  for (let y = 0; y < cleaned.height; y += 1) {
    for (let x = 0; x < cleaned.width; x += 1) {
      if (!hasVisiblePixel(cleaned, x, y)) {
        continue;
      }
      if (isWhiteFringePixel(cleaned, x, y, sprite.backgroundColor)) {
        clearPixel(cleaned, x, y);
        continue;
      }
    }
  }

  const cropped = cropToVisiblePixels(cleaned);
  if (cropped.area === 0) {
    return cropToVisiblePixels(source);
  }

  return cropped;
}

function quantizeChannel(value: number): number {
  return Math.round(value / EDGE_QUANTIZE_STEP) * EDGE_QUANTIZE_STEP;
}

export function estimateBackgroundColor(image: PixelImageData): RGBColor {
  const buckets = new Map<string, { count: number; color: RGBColor }>();
  const pushColor = (x: number, y: number) => {
    const color = readColor(image, x, y);
    const key = [
      quantizeChannel(color.r),
      quantizeChannel(color.g),
      quantizeChannel(color.b),
      quantizeChannel(color.a)
    ].join(",");
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { count: 1, color });
    }
  };

  for (let x = 0; x < image.width; x += 1) {
    pushColor(x, 0);
    if (image.height > 1) {
      pushColor(x, image.height - 1);
    }
  }

  for (let y = 1; y < image.height - 1; y += 1) {
    pushColor(0, y);
    if (image.width > 1) {
      pushColor(image.width - 1, y);
    }
  }

  let dominant: RGBColor | null = null;
  let maxCount = -1;
  buckets.forEach(({ count, color }) => {
    if (count > maxCount) {
      maxCount = count;
      dominant = color;
    }
  });

  return dominant ?? { r: 255, g: 255, b: 255, a: 255 };
}

export function colorDistance(a: RGBColor, b: RGBColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const da = a.a - b.a;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

function isForegroundPixel(
  image: PixelImageData,
  x: number,
  y: number,
  background: RGBColor,
  tolerance: number
): boolean {
  const color = readColor(image, x, y);
  if (color.a === 0) {
    return false;
  }
  return colorDistance(color, background) > tolerance;
}

function cropComponent(
  image: PixelImageData,
  componentPixels: Array<{ x: number; y: number }>,
  minX: number,
  minY: number,
  width: number,
  height: number
): PixelImageData {
  const data = new Uint8ClampedArray(width * height * 4);

  for (const pixel of componentPixels) {
    const sourceOffset = getOffset(image.width, pixel.x, pixel.y);
    const targetX = pixel.x - minX;
    const targetY = pixel.y - minY;
    const targetOffset = getOffset(width, targetX, targetY);
    data[targetOffset] = image.data[sourceOffset];
    data[targetOffset + 1] = image.data[sourceOffset + 1];
    data[targetOffset + 2] = image.data[sourceOffset + 2];
    data[targetOffset + 3] = image.data[sourceOffset + 3];
  }

  return {
    width,
    height,
    data
  };
}

export function detectSprites(
  image: PixelImageData,
  settings: DetectionSettings
): { background: RGBColor; sprites: DetectedSprite[] } {
  const background = estimateBackgroundColor(image);
  const visited = new Uint8Array(image.width * image.height);
  const sprites: DetectedSprite[] = [];

  const markVisited = (x: number, y: number) => {
    visited[y * image.width + x] = 1;
  };

  const wasVisited = (x: number, y: number) => visited[y * image.width + x] === 1;

  const neighbors = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1]
  ];

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (wasVisited(x, y)) {
        continue;
      }

      markVisited(x, y);
      if (!isForegroundPixel(image, x, y, background, settings.tolerance)) {
        continue;
      }

      const stack = [{ x, y }];
      const componentPixels: Array<{ x: number; y: number }> = [];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          break;
        }

        componentPixels.push(current);
        minX = Math.min(minX, current.x);
        maxX = Math.max(maxX, current.x);
        minY = Math.min(minY, current.y);
        maxY = Math.max(maxY, current.y);

        for (const [dx, dy] of neighbors) {
          const nextX = current.x + dx;
          const nextY = current.y + dy;
          if (
            nextX < 0 ||
            nextY < 0 ||
            nextX >= image.width ||
            nextY >= image.height ||
            wasVisited(nextX, nextY)
          ) {
            continue;
          }

          markVisited(nextX, nextY);
          if (isForegroundPixel(image, nextX, nextY, background, settings.tolerance)) {
            stack.push({ x: nextX, y: nextY });
          }
        }
      }

      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const area = componentPixels.length;
      if (area < settings.minArea || width < settings.minWidth || height < settings.minHeight) {
        continue;
      }

      const croppedImage = cropComponent(image, componentPixels, minX, minY, width, height);
      const refined = refineSpriteSubject({
        croppedImage,
        backgroundColor: background
      });
      const deFringed = removeWhiteFringe({
        croppedImage: refined.image,
        backgroundColor: background
      });
      sprites.push({
        id: `sprite-${sprites.length + 1}`,
        bounds: {
          x: minX + refined.offsetX + deFringed.offsetX,
          y: minY + refined.offsetY + deFringed.offsetY,
          width: deFringed.width,
          height: deFringed.height
        },
        width: deFringed.width,
        height: deFringed.height,
        area: deFringed.area,
        order: 0,
        backgroundColor: background,
        croppedImage: deFringed.image
      });
    }
  }

  sprites.sort((a, b) => {
    const rowDelta = a.bounds.y - b.bounds.y;
    if (Math.abs(rowDelta) > Math.max(4, Math.min(a.height, b.height) / 2)) {
      return rowDelta;
    }
    return a.bounds.x - b.bounds.x;
  });

  return {
    background,
    sprites: sprites.map((sprite, index) => ({
      ...sprite,
      order: index
    }))
  };
}
