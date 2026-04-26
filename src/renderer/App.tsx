import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { calculateVisibleArea, cropImageByRect, extractCutoutSprites, isRectFullyContained } from "../core/cutoutSprites";
import { buildCutoutSpritesheet } from "../core/cutoutSpritesheet";
import { applyMagicWandCutout, defaultMagicWandSettings } from "../core/magicWand";
import type {
  CutoutSprite,
  CutoutSpritesheetSettings,
  MagicWandResult,
  MagicWandSettings,
  PixelImageData,
  Rect,
  RGBColor
} from "../core/types";
import type { DesktopImageFile } from "../types/electron";
import { useElementSize } from "./hooks/useElementSize";
import { dataUrlToPixelImage, pixelImageToDataUrl } from "./utils";

interface LoadedImageState extends DesktopImageFile {
  pixels: PixelImageData;
}

type ActiveMode = "cutout" | "spritesheet";
type PanelId = "status" | "cutout" | "spritesheet" | "magic" | "result";
type ResizeHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

interface PreviewTransform {
  x: number;
  y: number;
  zoom: number;
}

type PreviewDragState =
  | {
      type: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startTransform: PreviewTransform;
    }
  | {
      type: "resize";
      pointerId: number;
      handle: ResizeHandle;
      startClientX: number;
      startClientY: number;
      startBounds: Rect;
      startTotalScale: number;
    };

interface CollapsiblePanelProps {
  id: PanelId;
  title: string;
  kicker: string;
  collapsed: boolean;
  onToggle: (id: PanelId) => void;
  children: ReactNode;
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stripExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "image";
}

function formatColor(color: RGBColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
}

const defaultSpritesheetSettings: CutoutSpritesheetSettings = {
  cellWidth: 32,
  cellHeight: 32,
  columns: 4,
  resampleMode: "pixel"
};

const modeTutorials: Record<ActiveMode, string> = {
  cutout: "切图导出：先导入图片并调整抠图参数，再点击透明预览上的识别框，最后把选中的图案导出为一张张独立 PNG。",
  spritesheet:
    "精灵表导出：先在透明预览里选择图案，再设置 8/16/32/64 或自定义分辨率、固定列数和采样模式，最后导出单张精灵表 PNG。"
};

const defaultCollapsedPanels: Record<PanelId, boolean> = {
  status: true,
  cutout: true,
  spritesheet: true,
  magic: true,
  result: true
};

const defaultPreviewTransform: PreviewTransform = {
  x: 0,
  y: 0,
  zoom: 1
};

const resizeHandles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function CollapsiblePanel({
  id,
  title,
  kicker,
  collapsed,
  onToggle,
  children,
  className = ""
}: CollapsiblePanelProps) {
  return (
    <section className={`collapsible-panel ${className} ${collapsed ? "is-collapsed" : "is-open"}`}>
      <button className="collapsible-header" type="button" aria-expanded={!collapsed} onClick={() => onToggle(id)}>
        <span>
          <span className="section-kicker">{kicker}</span>
          <strong>{title}</strong>
        </span>
        <span className="collapse-arrow" aria-hidden="true" />
      </button>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}

export default function App() {
  const [loadedImage, setLoadedImage] = useState<LoadedImageState | null>(null);
  const [settings, setSettings] = useState<MagicWandSettings>(defaultMagicWandSettings);
  const [result, setResult] = useState<MagicWandResult | null>(null);
  const [resultDataUrl, setResultDataUrl] = useState<string | null>(null);
  const [cutoutSprites, setCutoutSprites] = useState<CutoutSprite[]>([]);
  const [selectedSpriteIds, setSelectedSpriteIds] = useState<string[]>([]);
  const [activeMode, setActiveMode] = useState<ActiveMode>("cutout");
  const [collapsedPanels, setCollapsedPanels] = useState<Record<PanelId, boolean>>(defaultCollapsedPanels);
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false);
  const [spritesheetSettings, setSpritesheetSettings] =
    useState<CutoutSpritesheetSettings>(defaultSpritesheetSettings);
  const [previewFrameElement, setPreviewFrameElement] = useState<HTMLDivElement | null>(null);
  const [resultImageElement, setResultImageElement] = useState<HTMLImageElement | null>(null);
  const [resultImageReadyKey, setResultImageReadyKey] = useState(0);
  const [previewTransform, setPreviewTransform] = useState<PreviewTransform>(defaultPreviewTransform);
  const [isPanning, setIsPanning] = useState(false);
  const [editingSpriteId, setEditingSpriteId] = useState<string | null>(null);
  const [draftBounds, setDraftBounds] = useState<Rect | null>(null);
  const [message, setMessage] = useState("导入一张白底或纯色底图片，先把背景抠成透明。");
  const [busy, setBusy] = useState(false);
  const dragStateRef = useRef<PreviewDragState | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewAnimationRef = useRef<number | null>(null);
  const previewFrameSize = useElementSize(previewFrameElement);

  const removedRatio = useMemo(() => {
    if (!loadedImage || !result) {
      return "0%";
    }
    const total = loadedImage.pixels.width * loadedImage.pixels.height;
    return `${((result.removedPixelCount / total) * 100).toFixed(1)}%`;
  }, [loadedImage, result]);

  const selectedSprites = useMemo(
    () =>
      cutoutSprites
        .filter((sprite) => selectedSpriteIds.includes(sprite.id))
        .sort((a, b) => a.order - b.order),
    [cutoutSprites, selectedSpriteIds]
  );

  const editingSprite = useMemo(
    () => cutoutSprites.find((sprite) => sprite.id === editingSpriteId) ?? null,
    [cutoutSprites, editingSpriteId]
  );

  function getBaseImageScale() {
    if (!result || previewFrameSize.width === 0 || previewFrameSize.height === 0) {
      return 1;
    }

    const availableWidth = Math.max(1, previewFrameSize.width - 36);
    const availableHeight = Math.max(1, previewFrameSize.height - 36);
    return Math.min(availableWidth / result.image.width, availableHeight / result.image.height, 1);
  }

  function getTotalImageScale(transform = previewTransform) {
    return getBaseImageScale() * transform.zoom;
  }

  function imagePointToViewport(x: number, y: number, transform = previewTransform) {
    if (!result) {
      return { x: 0, y: 0 };
    }

    const totalScale = getTotalImageScale(transform);
    return {
      x: previewFrameSize.width / 2 + transform.x + (x - result.image.width / 2) * totalScale,
      y: previewFrameSize.height / 2 + transform.y + (y - result.image.height / 2) * totalScale
    };
  }

  function imageRectToViewportStyle(rect: Rect): CSSProperties {
    const topLeft = imagePointToViewport(rect.x, rect.y);
    const totalScale = getTotalImageScale();
    return {
      left: `${topLeft.x}px`,
      top: `${topLeft.y}px`,
      width: `${rect.width * totalScale}px`,
      height: `${rect.height * totalScale}px`
    };
  }

  function getFocusedTransform(bounds: Rect): PreviewTransform {
    if (!result || previewFrameSize.width === 0 || previewFrameSize.height === 0) {
      return defaultPreviewTransform;
    }

    const baseScale = getBaseImageScale();
    const displayWidth = Math.max(bounds.width * baseScale, 1);
    const displayHeight = Math.max(bounds.height * baseScale, 1);
    const zoom = clamp(Math.min(previewFrameSize.width / displayWidth, previewFrameSize.height / displayHeight) * 0.42, 1.35, 6);
    const spriteCenterX = bounds.x + bounds.width / 2;
    const spriteCenterY = bounds.y + bounds.height / 2;

    return {
      x: -(spriteCenterX - result.image.width / 2) * baseScale * zoom,
      y: -(spriteCenterY - result.image.height / 2) * baseScale * zoom,
      zoom
    };
  }

  function cancelPreviewAnimation() {
    if (previewAnimationRef.current !== null) {
      cancelAnimationFrame(previewAnimationRef.current);
      previewAnimationRef.current = null;
    }
  }

  function animatePreviewTransform(targetTransform: PreviewTransform) {
    cancelPreviewAnimation();
    const startTransform = previewTransform;
    const startedAt = performance.now();
    const duration = 340;

    const tick = (now: number) => {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      setPreviewTransform({
        x: startTransform.x + (targetTransform.x - startTransform.x) * eased,
        y: startTransform.y + (targetTransform.y - startTransform.y) * eased,
        zoom: startTransform.zoom + (targetTransform.zoom - startTransform.zoom) * eased
      });

      if (progress < 1) {
        previewAnimationRef.current = requestAnimationFrame(tick);
      } else {
        previewAnimationRef.current = null;
      }
    };

    previewAnimationRef.current = requestAnimationFrame(tick);
  }

  function resetPreviewTransform() {
    animatePreviewTransform(defaultPreviewTransform);
    setMessage("已把透明预览恢复到适合屏幕的默认位置。");
  }

  function clampBoundsToImage(bounds: Rect): Rect {
    if (!result) {
      return bounds;
    }

    const x = clamp(Math.round(bounds.x), 0, Math.max(0, result.image.width - 1));
    const y = clamp(Math.round(bounds.y), 0, Math.max(0, result.image.height - 1));
    const right = clamp(Math.round(bounds.x + bounds.width), x + 1, result.image.width);
    const bottom = clamp(Math.round(bounds.y + bounds.height), y + 1, result.image.height);
    return {
      x,
      y,
      width: right - x,
      height: bottom - y
    };
  }

  function resizeDraftBounds(handle: ResizeHandle, startBounds: Rect, deltaImageX: number, deltaImageY: number): Rect {
    if (!result) {
      return startBounds;
    }

    const originalRight = startBounds.x + startBounds.width;
    const originalBottom = startBounds.y + startBounds.height;
    let left = startBounds.x;
    let top = startBounds.y;
    let right = originalRight;
    let bottom = originalBottom;

    if (handle.includes("w")) {
      left = clamp(Math.round(startBounds.x + deltaImageX), 0, originalRight - 1);
    }
    if (handle.includes("e")) {
      right = clamp(Math.round(originalRight + deltaImageX), left + 1, result.image.width);
    }
    if (handle.includes("n")) {
      top = clamp(Math.round(startBounds.y + deltaImageY), 0, originalBottom - 1);
    }
    if (handle.includes("s")) {
      bottom = clamp(Math.round(originalBottom + deltaImageY), top + 1, result.image.height);
    }

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function drawPreviewCanvas(transform = previewTransform) {
    const canvas = previewCanvasRef.current;
    const image = resultImageElement;
    if (!canvas || !image || !result || previewFrameSize.width === 0 || previewFrameSize.height === 0) {
      return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    const canvasWidth = Math.max(1, Math.round(previewFrameSize.width));
    const canvasHeight = Math.max(1, Math.round(previewFrameSize.height));
    canvas.width = Math.round(canvasWidth * pixelRatio);
    canvas.height = Math.round(canvasHeight * pixelRatio);
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, canvasWidth, canvasHeight);
    context.imageSmoothingEnabled = false;
    context.translate(canvasWidth / 2 + transform.x, canvasHeight / 2 + transform.y);
    context.scale(getTotalImageScale(transform), getTotalImageScale(transform));
    context.drawImage(image, -result.image.width / 2, -result.image.height / 2, result.image.width, result.image.height);
  }

  useEffect(() => {
    drawPreviewCanvas();
  }, [previewTransform, previewFrameSize.width, previewFrameSize.height, resultImageReadyKey, resultDataUrl]);

  useEffect(() => {
    return () => cancelPreviewAnimation();
  }, []);

  function applyResult(nextResult: MagicWandResult) {
    const nextSprites = extractCutoutSprites(nextResult.image);
    setResult(nextResult);
    setCutoutSprites(nextSprites);
    setSelectedSpriteIds([]);
    setEditingSpriteId(null);
    setDraftBounds(null);
    setPreviewTransform(defaultPreviewTransform);
    return nextSprites;
  }

  async function runCutout(file: DesktopImageFile, nextSettings = settings) {
    setBusy(true);
    setMessage("正在读取图片并执行魔棒式边缘连通抠图...");

    try {
      const pixels = await dataUrlToPixelImage(file.dataUrl);
      const nextResult = applyMagicWandCutout(pixels, nextSettings);
      const nextDataUrl = await pixelImageToDataUrl(nextResult.image);
      const nextSprites = applyResult(nextResult);

      setLoadedImage({ ...file, pixels });
      setResultDataUrl(nextDataUrl);
      setMessage(
        `抠图完成：移除 ${nextResult.removedPixelCount.toLocaleString()} 个边缘背景像素，柔化 ${nextResult.softenedPixelCount.toLocaleString()} 个边缘像素，内缩剪掉 ${nextResult.erodedPixelCount.toLocaleString()} 个外圈像素，并识别到 ${nextSprites.length} 个可切图案。`
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "图片抠图失败";
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  async function rerunCutout(nextSettings = settings) {
    if (!loadedImage) {
      setMessage("请先导入图片。");
      return;
    }

    setBusy(true);
    setMessage("正在用当前参数重新抠图...");

    try {
      const nextResult = applyMagicWandCutout(loadedImage.pixels, nextSettings);
      const nextDataUrl = await pixelImageToDataUrl(nextResult.image);
      const nextSprites = applyResult(nextResult);
      setResultDataUrl(nextDataUrl);
      setMessage(
        `重新抠图完成：移除 ${nextResult.removedPixelCount.toLocaleString()} 个边缘背景像素，柔化 ${nextResult.softenedPixelCount.toLocaleString()} 个边缘像素，内缩剪掉 ${nextResult.erodedPixelCount.toLocaleString()} 个外圈像素，并识别到 ${nextSprites.length} 个可切图案。`
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "重新抠图失败";
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  function togglePanel(panelId: PanelId) {
    setCollapsedPanels((current) => ({
      ...current,
      [panelId]: !current[panelId]
    }));
  }

  async function handleOpenImage() {
    const file = await window.electronAPI.openImage();
    if (!file) {
      return;
    }

    await runCutout(file);
  }

  function updateSetting<Key extends keyof MagicWandSettings>(key: Key, value: MagicWandSettings[Key]) {
    const nextSettings = { ...settings, [key]: value };
    setSettings(nextSettings);

    if (loadedImage) {
      setMessage("参数已更新，松开滑条或输入完成后会自动重新抠图。");
    }
  }

  function commitMagicWandSettings(nextSettings = settings) {
    setSettings(nextSettings);
    if (!loadedImage) {
      setMessage("魔棒参数已更新，导入图片后生效。");
      return;
    }
    void rerunCutout(nextSettings);
  }

  function commitNumberSetting(key: keyof MagicWandSettings, value: number) {
    commitMagicWandSettings({ ...settings, [key]: value });
  }

  async function savePngWithRename(defaultFilename: string, dataUrl: string) {
    return window.electronAPI.savePngFile({
      defaultFilename,
      dataUrl
    });
  }

  async function savePngBatchWithRename(defaultFilename: string, dataUrls: string[]) {
    return window.electronAPI.savePngFiles({
      defaultFilename,
      files: dataUrls.map((dataUrl) => ({ dataUrl }))
    });
  }

  async function exportCutout() {
    if (!loadedImage || !resultDataUrl) {
      setMessage("还没有可导出的抠图结果。");
      return;
    }

    const filename = `cutout_${sanitizeFilename(stripExtension(loadedImage.name))}.png`;
    const saved = await savePngWithRename(filename, resultDataUrl);
    if (!saved) {
      return;
    }

    setMessage(`已导出原图尺寸透明 PNG：${saved.path}`);
  }

  function toggleSpriteSelection(spriteId: string) {
    if (editingSpriteId) {
      return;
    }
    setSelectedSpriteIds((current) =>
      current.includes(spriteId) ? current.filter((id) => id !== spriteId) : current.concat(spriteId)
    );
  }

  function enterSpriteEdit(spriteId: string) {
    const sprite = cutoutSprites.find((item) => item.id === spriteId);
    if (!sprite) {
      return;
    }

    setEditingSpriteId(sprite.id);
    setDraftBounds(sprite.bounds);
    setSelectedSpriteIds((current) => (current.includes(sprite.id) ? current : current.concat(sprite.id)));
    animatePreviewTransform(getFocusedTransform(sprite.bounds));
    setMessage(`正在编辑 ${sprite.id} 的裁切边界。拖动边或角调整范围，保存后会自动合并被完整框住的小图块。`);
  }

  function cancelSpriteEdit() {
    setEditingSpriteId(null);
    setDraftBounds(null);
    setMessage("已取消边界编辑，切图结果未改变。");
  }

  function saveSpriteEdit() {
    if (!result || !editingSprite || !draftBounds) {
      return;
    }

    const nextBounds = clampBoundsToImage(draftBounds);
    const area = calculateVisibleArea(result.image, nextBounds);
    if (area === 0) {
      setMessage("当前编辑边界里没有可见像素，请扩大范围或取消编辑。");
      return;
    }

    const croppedImage = cropImageByRect(result.image, nextBounds);
    const containedIds = new Set(
      cutoutSprites
        .filter((sprite) => sprite.id !== editingSprite.id && isRectFullyContained(sprite.bounds, nextBounds))
        .map((sprite) => sprite.id)
    );

    const nextSprite: CutoutSprite = {
      ...editingSprite,
      bounds: nextBounds,
      width: nextBounds.width,
      height: nextBounds.height,
      area,
      croppedImage
    };

    setCutoutSprites((current) =>
      current
        .filter((sprite) => !containedIds.has(sprite.id))
        .map((sprite) => (sprite.id === editingSprite.id ? nextSprite : sprite))
    );
    setSelectedSpriteIds((current) => {
      const nextIds = current.filter((id) => !containedIds.has(id));
      return nextIds.includes(editingSprite.id) ? nextIds : nextIds.concat(editingSprite.id);
    });
    setEditingSpriteId(null);
    setDraftBounds(null);
    setMessage(
      `已保存 ${editingSprite.id} 的新边界 ${nextBounds.width} x ${nextBounds.height}，并自动合并 ${containedIds.size} 个被完整框住的图块。`
    );
  }

  function handlePreviewWheel(event: WheelEvent<HTMLDivElement>) {
    if (!resultDataUrl) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;

    cancelPreviewAnimation();
    setPreviewTransform((current) => {
      const zoom = clamp(current.zoom * zoomFactor, 0.35, 8);
      const ratio = zoom / current.zoom;
      return {
        x: pointerX - (pointerX - current.x) * ratio,
        y: pointerY - (pointerY - current.y) * ratio,
        zoom
      };
    });
  }

  function handlePreviewPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!resultDataUrl || event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".cutout-box") || target.closest(".preview-tool-button") || target.closest(".edit-action-bar")) {
      return;
    }

    cancelPreviewAnimation();
    setIsPanning(true);
    dragStateRef.current = {
      type: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTransform: previewTransform
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizePointerDown(event: PointerEvent<HTMLButtonElement>, handle: ResizeHandle) {
    if (!draftBounds) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cancelPreviewAnimation();
    dragStateRef.current = {
      type: "resize",
      pointerId: event.pointerId,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBounds: draftBounds,
      startTotalScale: getTotalImageScale(previewTransform)
    };
    previewFrameElement?.setPointerCapture(event.pointerId);
  }

  function handlePreviewPointerMove(event: PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (dragState.type === "pan") {
      setPreviewTransform({
        ...dragState.startTransform,
        x: dragState.startTransform.x + event.clientX - dragState.startClientX,
        y: dragState.startTransform.y + event.clientY - dragState.startClientY
      });
      return;
    }

    const deltaImageX = (event.clientX - dragState.startClientX) / Math.max(dragState.startTotalScale, 0.001);
    const deltaImageY = (event.clientY - dragState.startClientY) / Math.max(dragState.startTotalScale, 0.001);
    setDraftBounds(resizeDraftBounds(dragState.handle, dragState.startBounds, deltaImageX, deltaImageY));
  }

  function handlePreviewPointerUp(event: PointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function selectAllSprites() {
    setSelectedSpriteIds(cutoutSprites.map((sprite) => sprite.id));
    setMessage(`已选中 ${cutoutSprites.length} 个切图。`);
  }

  function clearSpriteSelection() {
    setSelectedSpriteIds([]);
    setMessage("已清空当前切图选择。");
  }

  async function exportSelectedSprites() {
    if (!loadedImage || selectedSprites.length === 0) {
      setMessage("请先在抠图结果上选择至少一个图案。");
      return;
    }

    const baseName = sanitizeFilename(stripExtension(loadedImage.name));
    if (selectedSprites.length === 1) {
      const sprite = selectedSprites[0];
      const dataUrl = await pixelImageToDataUrl(sprite.croppedImage);
      const filename = `${baseName}_cut_001_${sprite.width}x${sprite.height}.png`;
      const saved = await savePngWithRename(filename, dataUrl);
      if (!saved) {
        return;
      }

      setMessage(`已导出 1 张独立切图：${saved.path}`);
      return;
    }

    const dataUrls: string[] = [];
    for (const sprite of selectedSprites) {
      dataUrls.push(await pixelImageToDataUrl(sprite.croppedImage));
    }

    const saved = await savePngBatchWithRename(`${baseName}_cut.png`, dataUrls);
    if (!saved) {
      return;
    }

    setMessage(`已导出 ${saved.paths.length} 张切图，命名为 ${saved.paths[0]} 起。`);
  }

  function applySpritesheetPreset(size: number) {
    setSpritesheetSettings((current) => ({
      ...current,
      cellWidth: size,
      cellHeight: size
    }));
    setMessage(`精灵表单元格已切换为 ${size} x ${size}。`);
  }

  function updateSpritesheetSetting<Key extends keyof CutoutSpritesheetSettings>(
    key: Key,
    value: CutoutSpritesheetSettings[Key]
  ) {
    setSpritesheetSettings((current) => ({
      ...current,
      [key]: value
    }));
  }

  async function exportSpritesheet() {
    if (!loadedImage || selectedSprites.length === 0) {
      setMessage("请先选择至少一个切图再导出精灵表。");
      return;
    }

    const normalizedSettings: CutoutSpritesheetSettings = {
      cellWidth: Math.max(1, Math.round(spritesheetSettings.cellWidth)),
      cellHeight: Math.max(1, Math.round(spritesheetSettings.cellHeight)),
      columns: clamp(Math.round(spritesheetSettings.columns), 1, 12),
      resampleMode: spritesheetSettings.resampleMode
    };

    try {
      const sheet = buildCutoutSpritesheet(selectedSprites, normalizedSettings);
      const dataUrl = await pixelImageToDataUrl(sheet.image);
      const baseName = sanitizeFilename(stripExtension(loadedImage.name));
      const modeText = normalizedSettings.resampleMode === "pixel" ? "pixel" : "smooth";
      const filename = `${baseName}_spritesheet_${normalizedSettings.cellWidth}x${normalizedSettings.cellHeight}_${modeText}.png`;
      const saved = await savePngWithRename(filename, dataUrl);
      if (!saved) {
        return;
      }

      setMessage(
        `已导出精灵表：${sheet.columns} 列 x ${sheet.rows} 行，单元格 ${normalizedSettings.cellWidth} x ${normalizedSettings.cellHeight}，路径：${saved.path}`
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "精灵表导出失败";
      setMessage(text);
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-block">
          <p className="eyebrow">2D Sprite Sheet Export</p>
          <h1>2D 精灵表格导出</h1>
          <p className="intro">{modeTutorials[activeMode]}</p>
        </div>
        <div className="toolbar">
          <button className="primary-button" onClick={handleOpenImage} disabled={busy}>
            {busy ? "处理中..." : "导入图片"}
          </button>
          <button
            className={`secondary-button mode-tab ${activeMode === "cutout" ? "is-active" : ""}`}
            onClick={() => setActiveMode("cutout")}
          >
            切图导出
          </button>
          <button
            className={`secondary-button mode-tab ${activeMode === "spritesheet" ? "is-active" : ""}`}
            onClick={() => setActiveMode("spritesheet")}
          >
            精灵表导出
          </button>
        </div>
      </header>

      <main className="wand-workspace">
        <section className={`preview-grid ${isSourceCollapsed ? "is-source-collapsed" : ""}`} aria-label="图片预览">
          {isSourceCollapsed ? (
            <button className="source-rail" type="button" onClick={() => setIsSourceCollapsed(false)}>
              <span>Source</span>
              <strong>展开原图</strong>
            </button>
          ) : (
            <article className="preview-card source-card">
              <div className="panel-title source-title">
                <span>
                  <p className="section-kicker">Source</p>
                  <h2>{loadedImage?.name ?? "原图预览"}</h2>
                </span>
                <button
                  className="source-collapse-button"
                  type="button"
                  onClick={() => setIsSourceCollapsed(true)}
                  aria-label="收起原图预览"
                >
                  ← 收起
                </button>
              </div>
              <div className="preview-frame source-frame">
                {loadedImage ? (
                  <img className="preview-image" src={loadedImage.dataUrl} alt="原图" />
                ) : (
                  <div className="empty-state">
                    <span>PNG / JPG / WEBP</span>
                    <strong>导入图片后会显示原始背景</strong>
                  </div>
                )}
              </div>
            </article>
          )}

          <article className="preview-card">
            <div className="panel-title">
              <p className="section-kicker">Transparent PNG</p>
              <h2>抠图结果</h2>
            </div>
            <div
              ref={setPreviewFrameElement}
              className={`preview-frame checkerboard transparent-frame ${isPanning ? "is-panning" : ""}`}
              onWheel={handlePreviewWheel}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={handlePreviewPointerUp}
              onPointerCancel={handlePreviewPointerUp}
            >
              {resultDataUrl ? (
                <>
                  <div className="preview-tools">
                    <div className="preview-tool-row">
                      {editingSprite && draftBounds ? (
                        <div className="edit-action-bar">
                          <span>
                            编辑 {editingSprite.id} · {draftBounds.width} x {draftBounds.height}
                          </span>
                          <button className="secondary-button compact-button" type="button" onClick={cancelSpriteEdit}>
                            取消
                          </button>
                          <button className="primary-button compact-button" type="button" onClick={saveSpriteEdit}>
                            保存
                          </button>
                        </div>
                      ) : null}
                      <button className="preview-tool-button" type="button" onClick={resetPreviewTransform} aria-label="回到中心">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 5V2L7 7l5 5V9a5 5 0 1 1-4.58 3H5.29A7 7 0 1 0 12 5Z" />
                        </svg>
                      </button>
                    </div>
                    <div className="preview-hints" aria-label="鼠标操作提示">
                      <span>
                        <i className="hint-icon hint-drag" aria-hidden="true" />
                        左键移动
                      </span>
                      <span>
                        <i className="hint-icon hint-wheel" aria-hidden="true" />
                        滚轮缩放
                      </span>
                    </div>
                  </div>

                  <canvas ref={previewCanvasRef} className="cutout-canvas" aria-label="透明背景抠图结果" />
                  <img
                    ref={setResultImageElement}
                    className="canvas-source-image"
                    src={resultDataUrl}
                    alt=""
                    draggable={false}
                    onLoad={() => setResultImageReadyKey((current) => current + 1)}
                  />

                  <div className="selection-overlay viewport-overlay">
                    {!editingSpriteId &&
                      cutoutSprites.map((sprite) => (
                        <div
                          key={sprite.id}
                          className={`cutout-box ${selectedSpriteIds.includes(sprite.id) ? "is-selected" : ""}`}
                          style={imageRectToViewportStyle(sprite.bounds)}
                          onClick={() => toggleSpriteSelection(sprite.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              toggleSpriteSelection(sprite.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          title={`${sprite.id}: ${sprite.width} x ${sprite.height}`}
                        >
                          <span>{sprite.order + 1}</span>
                          <button
                            className="edit-sprite-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              enterSpriteEdit(sprite.id);
                            }}
                          >
                            编辑
                          </button>
                        </div>
                      ))}
                    {editingSprite && draftBounds && (
                      <div className="edit-crop-box" style={imageRectToViewportStyle(draftBounds)}>
                        {resizeHandles.map((handle) => (
                          <button
                            key={handle}
                            className={`resize-handle resize-${handle}`}
                            type="button"
                            aria-label={`调整 ${handle} 边界`}
                            onPointerDown={(event) => handleResizePointerDown(event, handle)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <span>Alpha Preview</span>
                  <strong>透明结果会显示在棋盘格上</strong>
                </div>
              )}
            </div>
          </article>
        </section>

        <aside className="control-panel">
          <CollapsiblePanel
            id="status"
            title="状态"
            kicker="运行状态"
            collapsed={collapsedPanels.status}
            onToggle={togglePanel}
            className="status-card"
          >
            <p className="status-text">{message}</p>
          </CollapsiblePanel>

          {activeMode === "cutout" && (
            <CollapsiblePanel
              id="cutout"
              title="切图导出"
              kicker="Cut"
              collapsed={collapsedPanels.cutout}
              onToggle={togglePanel}
              className="control-card cutout-card"
            >
              <p className="cutout-note">
                在左侧透明预览上点击识别框可选择/取消。导出选中切图时，每个框会保存为一张独立透明 PNG。
              </p>
              <div className="selection-actions">
                <button className="secondary-button" onClick={selectAllSprites} disabled={cutoutSprites.length === 0}>
                  全选
                </button>
                <button className="secondary-button" onClick={clearSpriteSelection} disabled={selectedSprites.length === 0}>
                  清空
                </button>
                <button className="secondary-button" onClick={exportCutout} disabled={!resultDataUrl || busy}>
                  导出整张 PNG
                </button>
                <button className="primary-button" onClick={exportSelectedSprites} disabled={selectedSprites.length === 0}>
                  导出选中切图
                </button>
              </div>
              <p className="selection-summary">
                已识别 {cutoutSprites.length} 个图案，已选择 {selectedSprites.length} 个。
              </p>
            </CollapsiblePanel>
          )}

          {activeMode === "spritesheet" && (
            <CollapsiblePanel
              id="spritesheet"
              title="精灵表导出"
              kicker="Sheet"
              collapsed={collapsedPanels.spritesheet}
              onToggle={togglePanel}
              className="control-card spritesheet-card"
            >
              <p className="cutout-note">
                仅使用当前选中的切图，按统一单元格等比缩放、居中透明留白后导出一张 PNG。
              </p>

              <div className="preset-row" aria-label="精灵表尺寸预设">
                {[8, 16, 32, 64].map((size) => (
                  <button
                    key={size}
                    className={`preset-button ${
                      spritesheetSettings.cellWidth === size && spritesheetSettings.cellHeight === size ? "is-active" : ""
                    }`}
                    onClick={() => applySpritesheetPreset(size)}
                  >
                    {size} x {size}
                  </button>
                ))}
              </div>

              <div className="advanced-grid sheet-size-grid">
                <label>
                  宽度
                  <input
                    type="number"
                    min="1"
                    max="512"
                    value={spritesheetSettings.cellWidth}
                    onChange={(event) =>
                      updateSpritesheetSetting("cellWidth", clamp(Number(event.target.value), 1, 512))
                    }
                  />
                </label>
                <label>
                  高度
                  <input
                    type="number"
                    min="1"
                    max="512"
                    value={spritesheetSettings.cellHeight}
                    onChange={(event) =>
                      updateSpritesheetSetting("cellHeight", clamp(Number(event.target.value), 1, 512))
                    }
                  />
                </label>
              </div>

              <label className="slider-row">
                <span>
                  固定列数
                  <small>行数会根据选中切图数量自动计算。</small>
                </span>
                <input
                  type="range"
                  min="1"
                  max="12"
                  value={spritesheetSettings.columns}
                  onChange={(event) => updateSpritesheetSetting("columns", Number(event.target.value))}
                />
                <output>{spritesheetSettings.columns} 列</output>
              </label>

              <div className="mode-toggle" aria-label="采样模式">
                <button
                  className={`preset-button ${spritesheetSettings.resampleMode === "pixel" ? "is-active" : ""}`}
                  onClick={() => updateSpritesheetSetting("resampleMode", "pixel")}
                >
                  像素
                </button>
                <button
                  className={`preset-button ${spritesheetSettings.resampleMode === "smooth" ? "is-active" : ""}`}
                  onClick={() => updateSpritesheetSetting("resampleMode", "smooth")}
                >
                  平滑
                </button>
              </div>

              <p className="selection-summary">
                预计尺寸：
                {selectedSprites.length > 0
                  ? `${spritesheetSettings.cellWidth * spritesheetSettings.columns} x ${
                      spritesheetSettings.cellHeight *
                      Math.ceil(selectedSprites.length / Math.max(1, spritesheetSettings.columns))
                    }`
                  : "-"}
              </p>

              <button className="primary-button full-width-button" onClick={exportSpritesheet} disabled={selectedSprites.length === 0}>
                导出精灵表
              </button>
            </CollapsiblePanel>
          )}

          <CollapsiblePanel
            id="magic"
            title="魔棒参数"
            kicker="Parameters"
            collapsed={collapsedPanels.magic}
            onToggle={togglePanel}
            className="control-card"
          >
            <label className="slider-row">
              <span>
                容差
                <small>背景颜色允许差异，越大越容易吃掉近白背景。</small>
              </span>
              <input
                type="range"
                min="0"
                max="120"
                value={settings.tolerance}
                onChange={(event) => updateSetting("tolerance", Number(event.target.value))}
                onPointerUp={(event) =>
                  commitMagicWandSettings({ ...settings, tolerance: Number(event.currentTarget.value) })
                }
              />
              <output>{settings.tolerance}</output>
            </label>

            <label className="slider-row">
              <span>
                边缘柔化
                <small>只处理紧邻已选背景的半背景像素，用来减少白边。</small>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={settings.edgeSoftness}
                onChange={(event) => updateSetting("edgeSoftness", Number(event.target.value))}
                onPointerUp={(event) =>
                  commitMagicWandSettings({ ...settings, edgeSoftness: Number(event.currentTarget.value) })
                }
              />
              <output>{settings.edgeSoftness}</output>
            </label>

            <label className="slider-row">
              <span>
                边缘内缩
                <small>把每个可见图案的 alpha 边缘向内剪掉指定像素，适合处理顽固白边。</small>
              </span>
              <input
                type="range"
                min="0"
                max="4"
                value={settings.edgeShrinkPixels}
                onChange={(event) => updateSetting("edgeShrinkPixels", Number(event.target.value))}
                onPointerUp={(event) =>
                  commitMagicWandSettings({ ...settings, edgeShrinkPixels: Number(event.currentTarget.value) })
                }
              />
              <output>{settings.edgeShrinkPixels}px</output>
            </label>

            <div className="advanced-grid">
              <label>
                边缘采样宽度
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={settings.sampleEdgeThickness}
                  onChange={(event) =>
                    updateSetting("sampleEdgeThickness", clamp(Number(event.target.value), 1, 12))
                  }
                  onBlur={(event) =>
                    commitNumberSetting("sampleEdgeThickness", clamp(Number(event.currentTarget.value), 1, 12))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitNumberSetting("sampleEdgeThickness", clamp(Number(event.currentTarget.value), 1, 12));
                    }
                  }}
                />
              </label>
              <label>
                背景色数量
                <input
                  type="number"
                  min="1"
                  max="3"
                  value={settings.maxBackgroundClusters}
                  onChange={(event) =>
                    updateSetting("maxBackgroundClusters", clamp(Number(event.target.value), 1, 3))
                  }
                  onBlur={(event) =>
                    commitNumberSetting("maxBackgroundClusters", clamp(Number(event.currentTarget.value), 1, 3))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitNumberSetting("maxBackgroundClusters", clamp(Number(event.currentTarget.value), 1, 3));
                    }
                  }}
                />
              </label>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            id="result"
            title="结果"
            kicker="Result"
            collapsed={collapsedPanels.result}
            onToggle={togglePanel}
            className="stats-card"
          >
            <div className="stats-grid">
              <span>
                原图尺寸
                <strong>{loadedImage ? `${loadedImage.pixels.width} x ${loadedImage.pixels.height}` : "-"}</strong>
              </span>
              <span>
                移除比例
                <strong>{removedRatio}</strong>
              </span>
              <span>
                背景像素
                <strong>{result?.removedPixelCount.toLocaleString() ?? "-"}</strong>
              </span>
              <span>
                柔化像素
                <strong>{result?.softenedPixelCount.toLocaleString() ?? "-"}</strong>
              </span>
              <span>
                内缩像素
                <strong>{result?.erodedPixelCount.toLocaleString() ?? "-"}</strong>
              </span>
              <span>
                切图数量
                <strong>{cutoutSprites.length || "-"}</strong>
              </span>
            </div>

            <div className="swatch-list" aria-label="自动估计背景色">
              {(result?.backgroundColors ?? []).map((color, index) => (
                <span key={`${color.r}-${color.g}-${color.b}-${index}`} title={formatColor(color)}>
                  <i style={{ backgroundColor: formatColor(color) }} />
                  {formatColor(color)}
                </span>
              ))}
            </div>
          </CollapsiblePanel>
        </aside>
      </main>
    </div>
  );
}
