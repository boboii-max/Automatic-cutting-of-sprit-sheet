export interface RGBColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface MagicWandSettings {
  tolerance: number;
  edgeSoftness: number;
  edgeShrinkPixels: number;
  sampleEdgeThickness: number;
  maxBackgroundClusters: number;
}

export interface MagicWandResult {
  image: PixelImageData;
  backgroundColors: RGBColor[];
  removedPixelCount: number;
  softenedPixelCount: number;
  erodedPixelCount: number;
}

export interface CutoutSprite {
  id: string;
  bounds: Rect;
  width: number;
  height: number;
  area: number;
  order: number;
  croppedImage: PixelImageData;
}

export interface CutoutSpriteSettings {
  alphaThreshold: number;
  minArea: number;
  minWidth: number;
  minHeight: number;
}

export type CutoutSpritesheetResampleMode = "pixel" | "smooth";

export interface CutoutSpritesheetSettings {
  cellWidth: number;
  cellHeight: number;
  columns: number;
  resampleMode: CutoutSpritesheetResampleMode;
}

export interface CutoutSpritesheetResult {
  image: PixelImageData;
  rows: number;
  columns: number;
}

export type EdgeCleanupMode = "standard" | "outline_strong";

export interface ExportOptions {
  edgeCleanupMode: EdgeCleanupMode;
}

export interface DetectionSettings {
  tolerance: number;
  minArea: number;
  minWidth: number;
  minHeight: number;
}

export interface DetectedSprite {
  id: string;
  bounds: Rect;
  width: number;
  height: number;
  area: number;
  order: number;
  backgroundColor: RGBColor;
  croppedImage: PixelImageData;
}

export interface SpriteGroup {
  id: string;
  label: string;
  cellWidth: number;
  cellHeight: number;
  columnCount: number;
  spriteIds: string[];
  scaleMode: "contain";
  resampleMode: "nearest";
  allowUpscale: boolean;
}

export interface ExportJob {
  groupId: string;
  filename: string;
  directory: string;
  cellWidth: number;
  cellHeight: number;
  columnCount: number;
}
