import { describe, expect, it } from "vitest";
import {
  detectSprites,
  estimateBackgroundColor,
  refineSpriteSubject,
  removeWhiteFringe
} from "../src/core/detection";
import {
  buildSpritesheet,
  cleanSpriteEdges,
  prepareSpriteForExport,
  resampleSpriteToGroup,
  validateSpritesForGroup
} from "../src/core/export";
import { calculateVisibleArea, cropImageByRect, extractCutoutSprites, isRectFullyContained } from "../src/core/cutoutSprites";
import { buildCutoutSpritesheet, resampleCutoutToCell } from "../src/core/cutoutSpritesheet";
import { applyMagicWandCutout } from "../src/core/magicWand";
import type { CutoutSprite, PixelImageData, SpriteGroup } from "../src/core/types";

function makeBlankImage(width: number, height: number, color = [255, 255, 255, 255]): PixelImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }
  return { width, height, data };
}

function paintRect(
  image: PixelImageData,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number, number]
) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const offset = (yy * image.width + xx) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    }
  }
}

function countNearBackgroundVisiblePixels(
  image: PixelImageData,
  background: [number, number, number, number],
  threshold: number
): number {
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3];
      if (alpha === 0) {
        continue;
      }
      const dr = image.data[offset] - background[0];
      const dg = image.data[offset + 1] - background[1];
      const db = image.data[offset + 2] - background[2];
      const da = alpha - background[3];
      const distance = Math.sqrt(dr * dr + dg * dg + db * db + da * da);
      if (distance <= threshold) {
        count += 1;
      }
    }
  }
  return count;
}

function alphaAt(image: PixelImageData, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3];
}

describe("magic wand cutout", () => {
  it("removes edge-connected white background while keeping an outlined light subject", () => {
    const image = makeBlankImage(10, 10, [255, 255, 255, 255]);
    paintRect(image, 2, 2, 6, 6, [18, 18, 18, 255]);
    paintRect(image, 3, 3, 4, 4, [248, 244, 232, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 12,
      edgeSoftness: 0,
      edgeShrinkPixels: 0,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(result.image.width).toBe(10);
    expect(result.image.height).toBe(10);
    expect(alphaAt(result.image, 0, 0)).toBe(0);
    expect(alphaAt(result.image, 2, 2)).toBe(255);
    expect(alphaAt(result.image, 4, 4)).toBe(255);
  });

  it("does not delete internal background-colored islands that are not connected to the image edge", () => {
    const image = makeBlankImage(12, 12, [255, 255, 255, 255]);
    paintRect(image, 3, 3, 6, 6, [20, 20, 20, 255]);
    paintRect(image, 5, 5, 2, 2, [255, 255, 255, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 16,
      edgeSoftness: 0,
      edgeShrinkPixels: 0,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(alphaAt(result.image, 0, 0)).toBe(0);
    expect(alphaAt(result.image, 5, 5)).toBe(255);
  });

  it("supports near-white backgrounds through tolerance", () => {
    const image = makeBlankImage(8, 8, [246, 247, 244, 255]);
    paintRect(image, 3, 3, 2, 2, [30, 30, 30, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 18,
      edgeSoftness: 0,
      edgeShrinkPixels: 0,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(alphaAt(result.image, 0, 0)).toBe(0);
    expect(alphaAt(result.image, 3, 3)).toBe(255);
  });

  it("softens edge matte pixels without changing the canvas size", () => {
    const image = makeBlankImage(7, 5, [255, 255, 255, 255]);
    paintRect(image, 3, 1, 2, 3, [25, 25, 25, 255]);
    paintRect(image, 2, 2, 1, 1, [235, 235, 235, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 10,
      edgeSoftness: 60,
      edgeShrinkPixels: 0,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(result.image.width).toBe(7);
    expect(result.image.height).toBe(5);
    expect(alphaAt(result.image, 2, 2)).toBeGreaterThan(0);
    expect(alphaAt(result.image, 2, 2)).toBeLessThan(255);
    expect(result.softenedPixelCount).toBeGreaterThan(0);
  });

  it("shrinks visible alpha edges by one pixel when edge shrink is enabled", () => {
    const image = makeBlankImage(10, 10, [255, 255, 255, 255]);
    paintRect(image, 2, 2, 6, 6, [20, 20, 20, 255]);
    paintRect(image, 3, 3, 4, 4, [180, 120, 80, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 12,
      edgeSoftness: 0,
      edgeShrinkPixels: 1,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(alphaAt(result.image, 2, 2)).toBe(0);
    expect(alphaAt(result.image, 7, 7)).toBe(0);
    expect(alphaAt(result.image, 3, 3)).toBe(255);
    expect(result.erodedPixelCount).toBe(20);
  });

  it("softens the new edge after visible alpha edges are shrunk", () => {
    const image = makeBlankImage(8, 5, [255, 255, 255, 255]);
    paintRect(image, 2, 1, 1, 3, [230, 230, 230, 255]);
    paintRect(image, 3, 1, 1, 3, [235, 235, 235, 255]);
    paintRect(image, 4, 1, 2, 3, [25, 25, 25, 255]);

    const result = applyMagicWandCutout(image, {
      tolerance: 10,
      edgeSoftness: 60,
      edgeShrinkPixels: 1,
      sampleEdgeThickness: 1,
      maxBackgroundClusters: 1
    });

    expect(alphaAt(result.image, 2, 2)).toBe(0);
    expect(alphaAt(result.image, 3, 2)).toBeGreaterThan(0);
    expect(alphaAt(result.image, 3, 2)).toBeLessThan(255);
    expect(result.softenedPixelCount).toBeGreaterThan(0);
  });
});

describe("cutout sprite extraction", () => {
  it("extracts separate visible alpha regions into individual cropped PNG images", () => {
    const image = makeBlankImage(14, 8, [0, 0, 0, 0]);
    paintRect(image, 1, 1, 3, 4, [255, 0, 0, 255]);
    paintRect(image, 9, 2, 4, 3, [0, 120, 255, 255]);
    paintRect(image, 6, 0, 1, 1, [255, 255, 255, 255]);

    const sprites = extractCutoutSprites(image, {
      alphaThreshold: 8,
      minArea: 3,
      minWidth: 2,
      minHeight: 2
    });

    expect(sprites).toHaveLength(2);
    expect(sprites[0].bounds).toEqual({ x: 1, y: 1, width: 3, height: 4 });
    expect(sprites[1].bounds).toEqual({ x: 9, y: 2, width: 4, height: 3 });
    expect(sprites[0].croppedImage.width).toBe(3);
    expect(sprites[1].croppedImage.height).toBe(3);
  });

  it("keeps transparent pixels inside a component bounding box transparent", () => {
    const image = makeBlankImage(8, 8, [0, 0, 0, 0]);
    paintRect(image, 2, 2, 4, 1, [20, 20, 20, 255]);
    paintRect(image, 2, 5, 4, 1, [20, 20, 20, 255]);
    paintRect(image, 2, 2, 1, 4, [20, 20, 20, 255]);
    paintRect(image, 5, 2, 1, 4, [20, 20, 20, 255]);

    const [sprite] = extractCutoutSprites(image, {
      alphaThreshold: 8,
      minArea: 3,
      minWidth: 2,
      minHeight: 2
    });

    expect(sprite.croppedImage.width).toBe(4);
    expect(sprite.croppedImage.height).toBe(4);
    expect(alphaAt(sprite.croppedImage, 1, 1)).toBe(0);
    expect(alphaAt(sprite.croppedImage, 0, 0)).toBe(255);
  });

  it("crops any edited rectangle from the full transparent image", () => {
    const image = makeBlankImage(8, 7, [0, 0, 0, 0]);
    paintRect(image, 1, 1, 2, 2, [255, 0, 0, 255]);
    paintRect(image, 5, 3, 1, 2, [0, 255, 0, 255]);

    const cropped = cropImageByRect(image, { x: 1, y: 1, width: 5, height: 4 });

    expect(cropped.width).toBe(5);
    expect(cropped.height).toBe(4);
    expect(alphaAt(cropped, 0, 0)).toBe(255);
    expect(alphaAt(cropped, 4, 2)).toBe(255);
    expect(alphaAt(cropped, 3, 0)).toBe(0);
  });

  it("counts visible pixels and detects fully contained cutouts for manual merge", () => {
    const image = makeBlankImage(10, 10, [0, 0, 0, 0]);
    paintRect(image, 2, 2, 2, 2, [255, 0, 0, 255]);
    paintRect(image, 6, 4, 1, 3, [0, 255, 0, 255]);

    expect(calculateVisibleArea(image, { x: 1, y: 1, width: 7, height: 7 })).toBe(7);
    expect(isRectFullyContained({ x: 6, y: 4, width: 1, height: 3 }, { x: 1, y: 1, width: 7, height: 7 })).toBe(
      true
    );
    expect(isRectFullyContained({ x: 8, y: 4, width: 2, height: 2 }, { x: 1, y: 1, width: 7, height: 7 })).toBe(
      false
    );
  });
});

function makeCutoutSprite(id: string, image: PixelImageData, order: number): CutoutSprite {
  return {
    id,
    bounds: { x: 0, y: 0, width: image.width, height: image.height },
    width: image.width,
    height: image.height,
    area: image.width * image.height,
    order,
    croppedImage: image
  };
}

describe("cutout spritesheet export", () => {
  it("exports three selected cutouts into one default 32px row with four columns", () => {
    const sprites = [0, 1, 2].map((index) => {
      const image = makeBlankImage(8, 8, [0, 0, 0, 0]);
      paintRect(image, 0, 0, 8, 8, [20 + index, 20, 20, 255]);
      return makeCutoutSprite(`cut-${index}`, image, index);
    });

    const result = buildCutoutSpritesheet(sprites, {
      cellWidth: 32,
      cellHeight: 32,
      columns: 4,
      resampleMode: "pixel"
    });

    expect(result.image.width).toBe(128);
    expect(result.image.height).toBe(32);
    expect(result.rows).toBe(1);
    expect(result.columns).toBe(4);
  });

  it("uses additional rows when selected cutouts exceed the fixed column count", () => {
    const sprites = [0, 1, 2, 3, 4].map((index) => {
      const image = makeBlankImage(4, 4, [0, 0, 0, 0]);
      paintRect(image, 0, 0, 4, 4, [40, 40 + index, 40, 255]);
      return makeCutoutSprite(`cut-${index}`, image, index);
    });

    const result = buildCutoutSpritesheet(sprites, {
      cellWidth: 32,
      cellHeight: 32,
      columns: 4,
      resampleMode: "pixel"
    });

    expect(result.image.width).toBe(128);
    expect(result.image.height).toBe(64);
    expect(result.rows).toBe(2);
  });

  it("contains wide cutouts proportionally and centers them in transparent cells", () => {
    const image = makeBlankImage(20, 10, [0, 0, 0, 0]);
    paintRect(image, 0, 0, 20, 10, [200, 100, 20, 255]);

    const resampled = resampleCutoutToCell(image, {
      cellWidth: 32,
      cellHeight: 32,
      columns: 4,
      resampleMode: "pixel"
    });

    expect(resampled.width).toBe(32);
    expect(resampled.height).toBe(16);
    expect(resampled.offsetX).toBe(0);
    expect(resampled.offsetY).toBe(8);
  });

  it("keeps hard edges in pixel mode and blends edges in smooth mode", () => {
    const image = makeBlankImage(2, 2, [0, 0, 0, 0]);
    paintRect(image, 0, 0, 1, 2, [0, 0, 0, 255]);
    paintRect(image, 1, 0, 1, 2, [255, 255, 255, 255]);

    const pixel = resampleCutoutToCell(image, {
      cellWidth: 5,
      cellHeight: 5,
      columns: 1,
      resampleMode: "pixel"
    }).image;
    const smooth = resampleCutoutToCell(image, {
      cellWidth: 5,
      cellHeight: 5,
      columns: 1,
      resampleMode: "smooth"
    }).image;

    const pixelCenter = pixel.data[(2 * pixel.width + 2) * 4];
    const smoothCenter = smooth.data[(2 * smooth.width + 2) * 4];
    expect([0, 255]).toContain(pixelCenter);
    expect(smoothCenter).toBeGreaterThan(0);
    expect(smoothCenter).toBeLessThan(255);
  });
});

describe("sprite detection", () => {
  it("estimates the dominant edge color", () => {
    const image = makeBlankImage(10, 10, [252, 252, 248, 255]);
    paintRect(image, 3, 3, 2, 2, [0, 0, 0, 255]);
    const background = estimateBackgroundColor(image);
    expect(background.r).toBe(252);
    expect(background.g).toBe(252);
  });

  it("detects two separated sprites and ignores tiny noise", () => {
    const image = makeBlankImage(16, 16, [255, 255, 255, 255]);
    paintRect(image, 1, 1, 3, 3, [10, 10, 10, 255]);
    paintRect(image, 10, 10, 4, 2, [50, 0, 0, 255]);
    paintRect(image, 15, 0, 1, 1, [20, 20, 20, 255]);

    const result = detectSprites(image, {
      tolerance: 12,
      minArea: 3,
      minWidth: 2,
      minHeight: 2
    });

    expect(result.sprites).toHaveLength(2);
    expect(result.sprites[0].bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    expect(result.sprites[1].bounds).toEqual({ x: 10, y: 10, width: 4, height: 2 });
  });

  it("refines a sprite to keep the largest subject and nearby small components", () => {
    const cropped = makeBlankImage(10, 10, [0, 0, 0, 0]);
    paintRect(cropped, 4, 2, 4, 5, [20, 20, 20, 255]);
    paintRect(cropped, 2, 4, 1, 2, [20, 20, 20, 255]);
    paintRect(cropped, 0, 0, 1, 2, [20, 20, 20, 255]);

    const refined = refineSpriteSubject({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(refined.width).toBe(6);
    expect(refined.height).toBe(5);
    expect(refined.area).toBe(22);
    expect(refined.offsetX).toBe(2);
    expect(refined.offsetY).toBe(2);
    expect(refined.image.data[(0 * refined.image.width + 0) * 4 + 3]).toBe(0);
  });

  it("applies subject refinement during detection to remove distant artifacts", () => {
    const image = makeBlankImage(24, 24, [255, 255, 255, 255]);
    paintRect(image, 4, 4, 8, 10, [30, 30, 30, 255]);
    paintRect(image, 3, 8, 1, 1, [30, 30, 30, 255]);
    for (let y = 4; y < 9; y += 1) {
      paintRect(image, 12, y, 1, 1, [240, 240, 240, 255]);
    }

    const result = detectSprites(image, {
      tolerance: 8,
      minArea: 3,
      minWidth: 2,
      minHeight: 2
    });

    expect(result.sprites).toHaveLength(1);
    expect(result.sprites[0].bounds).toEqual({ x: 3, y: 4, width: 9, height: 10 });
    expect(result.sprites[0].croppedImage.width).toBe(9);
  });

  it("removes bright white fringe pixels while keeping dark outline pixels", () => {
    const cropped = makeBlankImage(6, 6, [0, 0, 0, 0]);
    paintRect(cropped, 1, 1, 3, 4, [0, 0, 0, 255]);
    paintRect(cropped, 0, 2, 1, 1, [236, 236, 236, 255]);
    paintRect(cropped, 4, 2, 1, 1, [242, 242, 242, 255]);

    const result = removeWhiteFringe({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(result.width).toBe(3);
    expect(result.height).toBe(4);
    expect(result.image.data[(1 * result.image.width + 0) * 4 + 3]).toBe(255);
    expect(result.offsetX).toBe(1);
  });

  it("applies white fringe removal during detection", () => {
    const image = makeBlankImage(18, 18, [255, 255, 255, 255]);
    paintRect(image, 4, 4, 6, 7, [35, 35, 35, 255]);
    paintRect(image, 3, 7, 1, 1, [235, 235, 235, 255]);
    paintRect(image, 10, 7, 1, 1, [238, 238, 238, 255]);

    const result = detectSprites(image, {
      tolerance: 10,
      minArea: 2,
      minWidth: 2,
      minHeight: 2
    });

    expect(result.sprites).toHaveLength(1);
    expect(result.sprites[0].bounds).toEqual({ x: 4, y: 4, width: 6, height: 7 });
    expect(result.sprites[0].croppedImage.data[(3 * result.sprites[0].croppedImage.width + 0) * 4 + 3]).toBe(255);
  });

  it("removes thin bright edge lines without depending on a high background tolerance", () => {
    const cropped = makeBlankImage(8, 8, [0, 0, 0, 0]);
    paintRect(cropped, 3, 2, 3, 4, [20, 20, 20, 255]);
    paintRect(cropped, 1, 2, 1, 3, [240, 240, 240, 255]);

    const result = removeWhiteFringe({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(result.offsetX).toBe(3);
    expect(result.width).toBe(3);
    expect(result.height).toBe(4);
  });

  it("removes a connected bright fringe chain when only part of it directly touches the dark outline", () => {
    const cropped = makeBlankImage(10, 10, [0, 0, 0, 0]);
    paintRect(cropped, 4, 2, 3, 6, [18, 18, 18, 255]);
    paintRect(cropped, 2, 2, 1, 5, [238, 238, 238, 255]);
    paintRect(cropped, 3, 6, 1, 1, [238, 238, 238, 255]);

    const result = removeWhiteFringe({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(result.offsetX).toBe(4);
    expect(result.width).toBe(3);
    expect(result.height).toBe(6);
  });

  it("removes a large connected halo ring instead of skipping it as one oversized fringe component", () => {
    const cropped = makeBlankImage(20, 20, [0, 0, 0, 0]);
    paintRect(cropped, 5, 4, 8, 10, [18, 18, 18, 255]);
    paintRect(cropped, 4, 3, 10, 12, [238, 238, 238, 255]);
    paintRect(cropped, 5, 4, 8, 10, [18, 18, 18, 255]);

    const result = removeWhiteFringe({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(result.offsetX).toBe(5);
    expect(result.offsetY).toBe(4);
    expect(result.width).toBe(8);
    expect(result.height).toBe(10);
  });

  it("peels multiple layers of border-connected halo around a dark outline", () => {
    const cropped = makeBlankImage(22, 22, [0, 0, 0, 0]);
    paintRect(cropped, 7, 6, 8, 10, [15, 15, 15, 255]);
    paintRect(cropped, 5, 4, 12, 14, [236, 236, 236, 255]);
    paintRect(cropped, 6, 5, 10, 12, [220, 220, 220, 255]);
    paintRect(cropped, 7, 6, 8, 10, [15, 15, 15, 255]);

    const result = removeWhiteFringe({
      croppedImage: cropped,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 }
    });

    expect(result.offsetX).toBe(7);
    expect(result.offsetY).toBe(6);
    expect(result.width).toBe(8);
    expect(result.height).toBe(10);
  });

  it("keeps light subject pixels at the default low tolerance when they are enclosed by the outline", () => {
    const image = makeBlankImage(14, 14, [255, 255, 255, 255]);
    paintRect(image, 4, 3, 4, 6, [25, 25, 25, 255]);
    paintRect(image, 5, 4, 2, 4, [244, 240, 228, 255]);

    const result = detectSprites(image, {
      tolerance: 16,
      minArea: 4,
      minWidth: 2,
      minHeight: 2
    });

    expect(result.sprites).toHaveLength(1);
    const sprite = result.sprites[0];
    const centerAlpha = sprite.croppedImage.data[(2 * sprite.croppedImage.width + 2) * 4 + 3];
    expect(centerAlpha).toBe(255);
  });
});

describe("spritesheet export", () => {
  it("validates and places sprites in a fixed grid", () => {
    const image = makeBlankImage(12, 12, [255, 255, 255, 255]);
    paintRect(image, 0, 0, 2, 2, [0, 0, 0, 255]);
    paintRect(image, 5, 5, 3, 3, [0, 0, 0, 255]);
    const sprites = detectSprites(image, {
      tolerance: 10,
      minArea: 2,
      minWidth: 2,
      minHeight: 2
    }).sprites;

    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 4,
      cellHeight: 4,
      columnCount: 2,
      spriteIds: sprites.map((sprite) => sprite.id),
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    expect(validateSpritesForGroup(sprites, group).valid).toBe(true);
    const layout = buildSpritesheet(sprites, group);
    expect(layout.image.width).toBe(8);
    expect(layout.image.height).toBe(4);
  });

  it("rescales oversized sprites to fit the target cell", () => {
    const spriteImage = makeBlankImage(300, 400, [0, 0, 0, 0]);
    paintRect(spriteImage, 0, 0, 300, 400, [10, 20, 30, 255]);
    const sprite = {
      id: "sprite-large",
      bounds: { x: 0, y: 0, width: 300, height: 400 },
      width: 300,
      height: 400,
      area: 120000,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };
    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 32,
      cellHeight: 32,
      columnCount: 1,
      spriteIds: [sprite.id],
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const resampled = resampleSpriteToGroup(sprite, group);
    expect(resampled.width).toBe(24);
    expect(resampled.height).toBe(32);
  });

  it("upscales small sprites with nearest-neighbor contain scaling", () => {
    const spriteImage = makeBlankImage(12, 18, [0, 0, 0, 0]);
    paintRect(spriteImage, 0, 0, 12, 18, [255, 0, 0, 255]);
    const sprite = {
      id: "sprite-small",
      bounds: { x: 0, y: 0, width: 12, height: 18 },
      width: 12,
      height: 18,
      area: 216,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };
    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 32,
      cellHeight: 32,
      columnCount: 1,
      spriteIds: [sprite.id],
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const resampled = resampleSpriteToGroup(sprite, group);
    expect(resampled.width).toBe(21);
    expect(resampled.height).toBe(32);
    expect(validateSpritesForGroup([sprite], group).valid).toBe(true);
  });

  it("cleans near-background edge noise before resampling", () => {
    const spriteImage = makeBlankImage(5, 5, [0, 0, 0, 0]);
    paintRect(spriteImage, 1, 1, 3, 3, [0, 0, 0, 255]);
    paintRect(spriteImage, 0, 2, 1, 1, [236, 236, 236, 255]);
    paintRect(spriteImage, 4, 2, 1, 1, [230, 230, 230, 255]);

    const sprite = {
      id: "sprite-edge-noise",
      bounds: { x: 0, y: 0, width: 5, height: 5 },
      width: 5,
      height: 5,
      area: 11,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };

    const cleaned = cleanSpriteEdges(sprite);
    expect(cleaned.data[(2 * cleaned.width + 0) * 4 + 3]).toBe(0);
    expect(cleaned.data[(2 * cleaned.width + 4) * 4 + 3]).toBe(0);
    expect(cleaned.data[(2 * cleaned.width + 2) * 4 + 3]).toBe(255);
  });

  it("keeps the standard export mode behavior by default", () => {
    const spriteImage = makeBlankImage(5, 5, [0, 0, 0, 0]);
    paintRect(spriteImage, 1, 1, 3, 3, [0, 0, 0, 255]);
    paintRect(spriteImage, 0, 2, 1, 1, [236, 236, 236, 255]);

    const sprite = {
      id: "sprite-standard-default",
      bounds: { x: 0, y: 0, width: 5, height: 5 },
      width: 5,
      height: 5,
      area: 10,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };
    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 5,
      cellHeight: 5,
      columnCount: 1,
      spriteIds: [sprite.id],
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const resampled = resampleSpriteToGroup(sprite, group);
    expect(resampled.image.data[(2 * resampled.width + 0) * 4 + 3]).toBe(0);
  });

  it("decontaminates white matte in outline-strong export mode before trimming", () => {
    const spriteImage = makeBlankImage(7, 7, [0, 0, 0, 0]);
    paintRect(spriteImage, 1, 1, 5, 5, [58, 42, 32, 255]);
    paintRect(spriteImage, 2, 2, 3, 3, [34, 26, 20, 255]);
    paintRect(spriteImage, 0, 3, 1, 1, [222, 214, 206, 255]);
    paintRect(spriteImage, 6, 3, 1, 1, [222, 214, 206, 255]);

    const sprite = {
      id: "sprite-strong-decontaminate",
      bounds: { x: 0, y: 0, width: 7, height: 7 },
      width: 7,
      height: 7,
      area: 27,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };

    const standard = prepareSpriteForExport(sprite);
    const strong = prepareSpriteForExport(sprite, { edgeCleanupMode: "outline_strong" });
    expect(countNearBackgroundVisiblePixels(standard, [255, 255, 255, 255], 90)).toBeGreaterThan(0);
    expect(countNearBackgroundVisiblePixels(strong, [255, 255, 255, 255], 90)).toBeLessThan(
      countNearBackgroundVisiblePixels(standard, [255, 255, 255, 255], 90)
    );
  });

  it("lightly trims residual halo in outline-strong export mode", () => {
    const spriteImage = makeBlankImage(7, 7, [0, 0, 0, 0]);
    paintRect(spriteImage, 1, 1, 5, 5, [25, 25, 25, 255]);
    paintRect(spriteImage, 0, 0, 7, 7, [205, 205, 205, 255]);
    paintRect(spriteImage, 1, 1, 5, 5, [25, 25, 25, 255]);
    paintRect(spriteImage, 0, 3, 1, 1, [214, 214, 214, 255]);

    const sprite = {
      id: "sprite-strong-trim",
      bounds: { x: 0, y: 0, width: 7, height: 7 },
      width: 7,
      height: 7,
      area: 26,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };

    const standard = prepareSpriteForExport(sprite);
    const strong = prepareSpriteForExport(sprite, { edgeCleanupMode: "outline_strong" });
    const standardOffset = (3 * standard.width + 0) * 4;
    const strongOffset = (3 * strong.width + 0) * 4;
    expect(standard.data[standardOffset + 3]).toBeGreaterThan(0);
    expect(
      strong.data[strongOffset + 3] < standard.data[standardOffset + 3] ||
        strong.data[strongOffset] < standard.data[standardOffset]
    ).toBe(true);
  });

  it("builds spritesheets with explicit export options", () => {
    const image = makeBlankImage(10, 10, [255, 255, 255, 255]);
    paintRect(image, 1, 1, 3, 3, [0, 0, 0, 255]);
    const sprites = detectSprites(image, {
      tolerance: 10,
      minArea: 2,
      minWidth: 2,
      minHeight: 2
    }).sprites;
    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 4,
      cellHeight: 4,
      columnCount: 1,
      spriteIds: sprites.map((sprite) => sprite.id),
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const validation = validateSpritesForGroup(sprites, group, { edgeCleanupMode: "outline_strong" });
    expect(validation.valid).toBe(true);
    const layout = buildSpritesheet(sprites, group, { edgeCleanupMode: "outline_strong" });
    expect(layout.image.width).toBe(4);
    expect(layout.image.height).toBe(4);
  });

  it("uses cleaned visible bounds when resampling after edge cleanup", () => {
    const spriteImage = makeBlankImage(7, 7, [0, 0, 0, 0]);
    paintRect(spriteImage, 1, 1, 5, 5, [20, 20, 20, 255]);
    paintRect(spriteImage, 0, 3, 1, 1, [236, 236, 236, 255]);
    paintRect(spriteImage, 6, 3, 1, 1, [236, 236, 236, 255]);

    const sprite = {
      id: "sprite-clean-bounds",
      bounds: { x: 0, y: 0, width: 7, height: 7 },
      width: 7,
      height: 7,
      area: 27,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };
    const group: SpriteGroup = {
      id: "g32",
      label: "32 x 32",
      cellWidth: 10,
      cellHeight: 10,
      columnCount: 1,
      spriteIds: [sprite.id],
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const resampled = resampleSpriteToGroup(sprite, group);
    expect(resampled.width).toBe(10);
    expect(resampled.height).toBe(10);
  });

  it("reports an error when edge cleanup removes every visible pixel", () => {
    const spriteImage = makeBlankImage(1, 1, [245, 245, 245, 255]);
    const sprite = {
      id: "sprite-empty-after-clean",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      width: 1,
      height: 1,
      area: 1,
      order: 0,
      backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
      croppedImage: spriteImage
    };
    const group: SpriteGroup = {
      id: "g1",
      label: "1 x 1",
      cellWidth: 1,
      cellHeight: 1,
      columnCount: 1,
      spriteIds: [sprite.id],
      scaleMode: "contain",
      resampleMode: "nearest",
      allowUpscale: true
    };

    const validation = validateSpritesForGroup([sprite], group);
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain("边缘净化后无有效像素");
  });
});
