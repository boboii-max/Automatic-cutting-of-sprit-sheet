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
