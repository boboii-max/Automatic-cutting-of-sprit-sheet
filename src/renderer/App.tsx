import { useMemo, useRef, useState } from "react";
import { buildSpritesheet, validateSpritesForGroup } from "../core/export";
import { detectSprites } from "../core/detection";
import type {
  DetectedSprite,
  DetectionSettings,
  EdgeCleanupMode,
  PixelImageData,
  SpriteGroup
} from "../core/types";
import type { DesktopImageFile } from "../types/electron";
import { useElementSize } from "./hooks/useElementSize";
import { dataUrlToPixelImage, pixelImageToDataUrl, rectToStyle } from "./utils";

interface LoadedImageState extends DesktopImageFile {
  pixels: PixelImageData;
}

interface SpriteView extends DetectedSprite {
  previewDataUrl: string;
}

const defaultSettings: DetectionSettings = {
  tolerance: 16,
  minArea: 6,
  minWidth: 2,
  minHeight: 2
};

const defaultGroups: SpriteGroup[] = [
  {
    id: "g32",
    label: "32 x 32",
    cellWidth: 32,
    cellHeight: 32,
    columnCount: 8,
    spriteIds: [],
    scaleMode: "contain",
    resampleMode: "nearest",
    allowUpscale: true
  },
  {
    id: "g64",
    label: "64 x 64",
    cellWidth: 64,
    cellHeight: 64,
    columnCount: 8,
    spriteIds: [],
    scaleMode: "contain",
    resampleMode: "nearest",
    allowUpscale: true
  }
];

function uniqueId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function sortSprites(sprites: SpriteView[]): SpriteView[] {
  return [...sprites].sort((a, b) => a.order - b.order);
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function intersectionArea(a: DetectedSprite, b: DetectedSprite): number {
  const left = Math.max(a.bounds.x, b.bounds.x);
  const top = Math.max(a.bounds.y, b.bounds.y);
  const right = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width);
  const bottom = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  return (right - left) * (bottom - top);
}

function getMatchScore(previousSprite: DetectedSprite, nextSprite: DetectedSprite): number {
  const overlap = intersectionArea(previousSprite, nextSprite);
  if (overlap === 0) {
    return 0;
  }

  const previousArea = previousSprite.bounds.width * previousSprite.bounds.height;
  const nextArea = nextSprite.bounds.width * nextSprite.bounds.height;
  const union = previousArea + nextArea - overlap;
  const overlapCoverage = overlap / Math.min(previousArea, nextArea);
  const iou = overlap / union;
  const sizePenalty =
    (Math.abs(previousSprite.width - nextSprite.width) +
      Math.abs(previousSprite.height - nextSprite.height)) /
    Math.max(previousSprite.width + previousSprite.height, 1);

  return overlapCoverage + iou - sizePenalty * 0.35;
}

function mapSpriteIds(previousSprites: SpriteView[], nextSprites: SpriteView[]): Map<string, string> {
  const candidates: Array<{ previousId: string; nextId: string; score: number }> = [];

  previousSprites.forEach((previousSprite) => {
    nextSprites.forEach((nextSprite) => {
      const score = getMatchScore(previousSprite, nextSprite);
      if (score >= 0.75) {
        candidates.push({
          previousId: previousSprite.id,
          nextId: nextSprite.id,
          score
        });
      }
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const mappedPrevious = new Set<string>();
  const mappedNext = new Set<string>();
  const idMap = new Map<string, string>();

  candidates.forEach((candidate) => {
    if (mappedPrevious.has(candidate.previousId) || mappedNext.has(candidate.nextId)) {
      return;
    }
    mappedPrevious.add(candidate.previousId);
    mappedNext.add(candidate.nextId);
    idMap.set(candidate.previousId, candidate.nextId);
  });

  return idMap;
}

function formatValidationMessage(group: SpriteGroup, errors: string[], prefix: string): string {
  const examples = errors
    .slice(0, 3)
    .map((error) => error)
    .join("、");
  const moreText = errors.length > 3 ? ` 等 ${errors.length} 个问题` : "";
  return `${prefix}：${group.label} 组无法完成重采样导出，${examples}${moreText}。`;
}

export default function App() {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [loadedImage, setLoadedImage] = useState<LoadedImageState | null>(null);
  const [settings, setSettings] = useState<DetectionSettings>(defaultSettings);
  const [sprites, setSprites] = useState<SpriteView[]>([]);
  const [groups, setGroups] = useState<SpriteGroup[]>(defaultGroups);
  const [selectedSpriteId, setSelectedSpriteId] = useState<string | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedSpriteIds, setSelectedSpriteIds] = useState<string[]>([]);
  const [ignoredSpriteIds, setIgnoredSpriteIds] = useState<string[]>([]);
  const [edgeCleanupMode, setEdgeCleanupMode] = useState<EdgeCleanupMode>("standard");
  const [message, setMessage] = useState("导入一张精灵杂图，软件会自动识别所有独立像素精灵。");
  const [busy, setBusy] = useState(false);
  const [groupDraft, setGroupDraft] = useState({
    width: "32",
    height: "32",
    columns: "8"
  });
  const stageSize = useElementSize(imageRef.current);

  const groupMap = useMemo(() => {
    return new Map(groups.map((group) => [group.id, group]));
  }, [groups]);

  const selectedSprite = sprites.find((sprite) => sprite.id === selectedSpriteId) ?? null;
  const selectedSprites = useMemo(
    () =>
      selectedSpriteIds
        .map((spriteId) => sprites.find((sprite) => sprite.id === spriteId) ?? null)
        .filter((sprite): sprite is SpriteView => sprite !== null),
    [selectedSpriteIds, sprites]
  );

  const unassignedCount = useMemo(() => {
    return sprites.filter((sprite) => {
      const assigned = groups.some((group) => group.spriteIds.includes(sprite.id));
      const ignored = ignoredSpriteIds.includes(sprite.id);
      return !assigned && !ignored;
    }).length;
  }, [groups, ignoredSpriteIds, sprites]);

  const unassignedSpriteIds = useMemo(() => {
    return sprites
      .filter((sprite) => {
        const assigned = groups.some((group) => group.spriteIds.includes(sprite.id));
        const ignored = ignoredSpriteIds.includes(sprite.id);
        return !assigned && !ignored;
      })
      .map((sprite) => sprite.id);
  }, [groups, ignoredSpriteIds, sprites]);

  async function runDetection(file: DesktopImageFile) {
    setBusy(true);
    setMessage("正在分析图片背景并识别精灵...");
    try {
      const isSameImage = loadedImage?.path === file.path;
      const pixels = await dataUrlToPixelImage(file.dataUrl);
      const result = detectSprites(pixels, settings);
      const nextSprites = await Promise.all(
        result.sprites.map(async (sprite) => ({
          ...sprite,
          previewDataUrl: await pixelImageToDataUrl(sprite.croppedImage)
        }))
      );

      const sortedNextSprites = sortSprites(nextSprites);
      const spriteIdMap = isSameImage ? mapSpriteIds(sprites, sortedNextSprites) : new Map<string, string>();
      const preservedGroups = isSameImage
        ? groups.map((group) => ({
            ...group,
            spriteIds: uniqueValues(group.spriteIds.map((id) => spriteIdMap.get(id)))
          }))
        : groups.map((group) => ({
            ...group,
            spriteIds: []
          }));
      const preservedIgnoredIds = isSameImage
        ? uniqueValues(ignoredSpriteIds.map((id) => spriteIdMap.get(id)))
        : [];
      const nextSelectedSpriteId =
        (isSameImage && selectedSpriteId ? spriteIdMap.get(selectedSpriteId) : undefined) ??
        sortedNextSprites[0]?.id ??
        null;

      setLoadedImage({ ...file, pixels });
      setSprites(sortedNextSprites);
      setGroups(preservedGroups);
      setIgnoredSpriteIds(preservedIgnoredIds);
      setSelectedSpriteId(nextSelectedSpriteId);
      setIsSelectionMode(false);
      setSelectedSpriteIds([]);
      setMessage(
        isSameImage
          ? `重新识别完成：找到 ${sortedNextSprites.length} 个精灵，并保留了 ${spriteIdMap.size} 个旧分组/忽略匹配结果；识别时已自动清理白底白边。`
          : `识别完成：找到 ${sortedNextSprites.length} 个精灵，背景估计为 rgba(${result.background.r}, ${result.background.g}, ${result.background.b}, ${result.background.a})，并已自动清理白底白边。`
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "图片读取失败";
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenImage() {
    const file = await window.electronAPI.openImage();
    if (!file) {
      return;
    }
    void runDetection(file);
  }

  function assignSpritesToGroup(spriteIds: string[], nextGroupId: string) {
    if (spriteIds.length === 0) {
      return;
    }

    setGroups((currentGroups) =>
      currentGroups.map((group) => {
        const withoutSelectedSprites = group.spriteIds.filter((id) => !spriteIds.includes(id));
        if (group.id !== nextGroupId) {
          return { ...group, spriteIds: withoutSelectedSprites };
        }
        return {
          ...group,
          spriteIds: withoutSelectedSprites.concat(spriteIds.filter((id) => !withoutSelectedSprites.includes(id)))
        };
      })
    );
    setIgnoredSpriteIds((current) => current.filter((id) => !spriteIds.includes(id)));
    setMessage(
      spriteIds.length === 1
        ? `已将精灵 ${spriteIds[0]} 分配到 ${groupMap.get(nextGroupId)?.label ?? "分组"}。`
        : `已将 ${spriteIds.length} 个精灵分配到 ${groupMap.get(nextGroupId)?.label ?? "分组"}。`
    );
  }

  function reassignSprite(spriteId: string, nextGroupId: string) {
    assignSpritesToGroup([spriteId], nextGroupId);
  }

  function ignoreSprites(spriteIds: string[]) {
    if (spriteIds.length === 0) {
      return;
    }

    setGroups((currentGroups) =>
      currentGroups.map((group) => ({
        ...group,
        spriteIds: group.spriteIds.filter((id) => !spriteIds.includes(id))
      }))
    );
    setIgnoredSpriteIds((current) => uniqueValues(current.concat(spriteIds)));
    setMessage(
      spriteIds.length === 1
        ? `已忽略 ${spriteIds[0]}，导出时不会包含它。`
        : `已忽略 ${spriteIds.length} 个精灵，导出时不会包含它们。`
    );
  }

  function ignoreSprite(spriteId: string) {
    ignoreSprites([spriteId]);
  }

  function restoreSprite(spriteId: string) {
    setIgnoredSpriteIds((current) => current.filter((id) => id !== spriteId));
    setMessage(`已恢复 ${spriteId}，现在可以重新分组。`);
  }

  function ignoreRemainingUnassigned() {
    if (unassignedSpriteIds.length === 0) {
      setMessage("当前没有剩余未分组元素。");
      return;
    }

    setIgnoredSpriteIds((current) => uniqueValues(current.concat(unassignedSpriteIds)));
    setMessage(`已一键忽略剩余 ${unassignedSpriteIds.length} 个未分组元素。`);
  }

  function enterSelectionMode() {
    setIsSelectionMode(true);
    setSelectedSpriteIds(selectedSpriteId ? [selectedSpriteId] : []);
  }

  function exitSelectionMode() {
    setIsSelectionMode(false);
    setSelectedSpriteIds([]);
  }

  function clearBatchSelection() {
    setSelectedSpriteIds([]);
    setMessage("已清空当前多选。");
  }

  function toggleSpriteSelection(spriteId: string) {
    setSelectedSpriteIds((current) =>
      current.includes(spriteId) ? current.filter((id) => id !== spriteId) : current.concat(spriteId)
    );
  }

  function handleSpritePress(spriteId: string) {
    if (isSelectionMode) {
      toggleSpriteSelection(spriteId);
      return;
    }
    setSelectedSpriteId(spriteId);
  }

  function batchAssign(groupId: string) {
    if (selectedSpriteIds.length === 0) {
      setMessage("请先选择至少一个精灵。");
      return;
    }
    assignSpritesToGroup(selectedSpriteIds, groupId);
    setSelectedSpriteIds([]);
  }

  function batchIgnore() {
    if (selectedSpriteIds.length === 0) {
      setMessage("请先选择至少一个精灵。");
      return;
    }
    ignoreSprites(selectedSpriteIds);
    setSelectedSpriteIds([]);
  }

  function addGroup() {
    const cellWidth = Number(groupDraft.width);
    const cellHeight = Number(groupDraft.height);
    const columnCount = Number(groupDraft.columns);
    if (!cellWidth || !cellHeight || !columnCount) {
      setMessage("请填写有效的尺寸和列数。");
      return;
    }

    const label = `${cellWidth} x ${cellHeight}`;
    setGroups((current) => [
      ...current,
      {
        id: uniqueId("group"),
        label,
        cellWidth,
        cellHeight,
        columnCount,
        spriteIds: [],
        scaleMode: "contain",
        resampleMode: "nearest",
        allowUpscale: true
      }
    ]);
    setMessage(`已新增分组 ${label}。`);
  }

  function updateGroupColumns(groupId: string, columnCount: number) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId ? { ...group, columnCount: Math.max(1, columnCount || 1) } : group
      )
    );
  }

  async function exportGroup(group: SpriteGroup) {
    const spriteList = group.spriteIds
      .map((spriteId) => sprites.find((sprite) => sprite.id === spriteId) ?? null)
      .filter((sprite): sprite is SpriteView => sprite !== null)
      .sort((a, b) => a.order - b.order);

    if (spriteList.length === 0) {
      setMessage(`分组 ${group.label} 还没有精灵。`);
      return;
    }

    const validation = validateSpritesForGroup(spriteList, group, { edgeCleanupMode });
    if (!validation.valid) {
      setMessage(formatValidationMessage(group, validation.errors, "导出失败"));
      return;
    }

    const directory = await window.electronAPI.chooseExportDirectory();
    if (!directory) {
      return;
    }

    const { image } = buildSpritesheet(spriteList, group, { edgeCleanupMode });
    const dataUrl = await pixelImageToDataUrl(image);
    const filename = `spritesheet_${group.cellWidth}x${group.cellHeight}.png`;
    const saved = await window.electronAPI.saveSpritesheet({ directory, filename, dataUrl });
    setMessage(
      `已导出 ${group.label} 精灵表到 ${saved.path}${
        edgeCleanupMode === "outline_strong" ? "（使用黑描边强去边模式）" : ""
      }`
    );
  }

  async function exportAll() {
    if (unassignedCount > 0) {
      setMessage(`还有 ${unassignedCount} 个精灵未分组，请先处理完再导出。`);
      return;
    }

    const directory = await window.electronAPI.chooseExportDirectory();
    if (!directory) {
      return;
    }

    for (const group of groups) {
      if (group.spriteIds.length === 0) {
        continue;
      }
      const spriteList = group.spriteIds
        .map((spriteId) => sprites.find((sprite) => sprite.id === spriteId) ?? null)
        .filter((sprite): sprite is SpriteView => sprite !== null)
        .sort((a, b) => a.order - b.order);
      const validation = validateSpritesForGroup(spriteList, group, { edgeCleanupMode });
      if (!validation.valid) {
        setMessage(formatValidationMessage(group, validation.errors, "导出中断"));
        return;
      }
      const { image } = buildSpritesheet(spriteList, group, { edgeCleanupMode });
      const dataUrl = await pixelImageToDataUrl(image);
      const filename = `spritesheet_${group.cellWidth}x${group.cellHeight}.png`;
      await window.electronAPI.saveSpritesheet({ directory, filename, dataUrl });
    }

    setMessage(
      `全部导出完成，目录：${directory}${
        edgeCleanupMode === "outline_strong" ? "（使用黑描边强去边模式）" : ""
      }`
    );
  }

  const imageNaturalWidth = loadedImage?.pixels.width ?? 1;
  const imageNaturalHeight = loadedImage?.pixels.height ?? 1;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Pixel Sprite Cuter</p>
          <h1>把零散像素精灵重新拼回标准表格</h1>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={handleOpenImage} disabled={busy}>
            {busy ? "识别中..." : "导入图片"}
          </button>
          <button
            className="secondary-button"
            onClick={() => (isSelectionMode ? exitSelectionMode() : enterSelectionMode())}
            disabled={sprites.length === 0}
          >
            {isSelectionMode ? "取消选择" : "选择"}
          </button>
          <button
            className="secondary-button"
            onClick={() => loadedImage && runDetection(loadedImage)}
            disabled={!loadedImage || busy}
          >
            重新识别
          </button>
          <button className="secondary-button" onClick={exportAll} disabled={sprites.length === 0}>
            导出全部分组
          </button>
          <button
            className="secondary-button"
            onClick={ignoreRemainingUnassigned}
            disabled={unassignedCount === 0}
          >
            忽略剩余未分组
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="canvas-panel">
          <div className="section-head">
            <div>
              <p className="section-kicker">原图预览</p>
              <h2>{loadedImage?.name ?? "还没有导入图片"}</h2>
            </div>
            <div className="status-chip">
              <span>{sprites.length} 个识别结果</span>
              <span>{unassignedCount} 个待分组</span>
              {isSelectionMode ? <span>{selectedSpriteIds.length} 个已选</span> : null}
            </div>
          </div>

          <div className="canvas-frame">
            {loadedImage ? (
              <div className="image-stage">
                <img
                  ref={imageRef}
                  className="main-image"
                  src={loadedImage.dataUrl}
                  alt="source"
                  draggable={false}
                />
                <div className="overlay-layer">
                  {sprites.map((sprite) => {
                    const assignedGroup = groups.find((group) => group.spriteIds.includes(sprite.id));
                    const isIgnored = ignoredSpriteIds.includes(sprite.id);
                    return (
                      <button
                        key={sprite.id}
                        type="button"
                        className={[
                          "sprite-box",
                          !isSelectionMode && selectedSpriteId === sprite.id ? "is-selected" : "",
                          isSelectionMode && selectedSpriteIds.includes(sprite.id) ? "is-batch-selected" : "",
                          assignedGroup ? "is-grouped" : "",
                          isIgnored ? "is-ignored" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={rectToStyle(
                          imageNaturalWidth,
                          imageNaturalHeight,
                          stageSize.width,
                          stageSize.height,
                          sprite.bounds
                        )}
                        onClick={() => handleSpritePress(sprite.id)}
                      >
                        <span>{assignedGroup?.label ?? (isIgnored ? "已忽略" : "待处理")}</span>
                        {isSelectionMode && selectedSpriteIds.includes(sprite.id) ? (
                          <em className="selection-badge">已选</em>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>支持 PNG / JPG / WEBP</p>
                <h3>先导入一张纯色或近似纯色背景的精灵杂图</h3>
                <p>软件会自动识别连通的像素区域，并允许你手动按尺寸分组。</p>
              </div>
            )}
          </div>

          <div className="settings-strip">
            <label>
              背景容差
              <input
                type="range"
                min="0"
                max="120"
                value={settings.tolerance}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    tolerance: Number(event.target.value)
                  }))
                }
              />
              <span>{settings.tolerance}</span>
            </label>
            <label>
              最小面积
              <input
                type="number"
                min="1"
                value={settings.minArea}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    minArea: Number(event.target.value) || 1
                  }))
                }
              />
            </label>
            <label>
              最小宽
              <input
                type="number"
                min="1"
                value={settings.minWidth}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    minWidth: Number(event.target.value) || 1
                  }))
                }
              />
            </label>
            <label>
              最小高
              <input
                type="number"
                min="1"
                value={settings.minHeight}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    minHeight: Number(event.target.value) || 1
                  }))
                }
              />
            </label>
          </div>
        </section>

        <aside className="sidebar">
          <section className="panel-card">
            <p className="section-kicker">{isSelectionMode ? "批量选择" : "当前选择"}</p>
            {isSelectionMode ? (
              <>
                <div className="selection-summary">
                  <h3>{selectedSpriteIds.length} 个已选精灵</h3>
                  <p className="muted">连续点击左侧识别框可勾选多个精灵，然后统一分组或忽略。</p>
                </div>
                <div className="selection-preview-grid">
                  {selectedSprites.length > 0 ? (
                    selectedSprites.slice(0, 12).map((sprite) => (
                      <img key={sprite.id} src={sprite.previewDataUrl} alt={sprite.id} />
                    ))
                  ) : (
                    <p className="muted">还没有选择任何精灵。</p>
                  )}
                </div>
                <div className="action-stack">
                  {groups.map((group) => (
                    <button
                      key={group.id}
                      className="group-assign-button"
                      onClick={() => batchAssign(group.id)}
                      disabled={selectedSpriteIds.length === 0}
                    >
                      批量分到 {group.label}
                    </button>
                  ))}
                  <button
                    className="ghost-button"
                    onClick={batchIgnore}
                    disabled={selectedSpriteIds.length === 0}
                  >
                    批量忽略
                  </button>
                  <button
                    className="ghost-button"
                    onClick={clearBatchSelection}
                    disabled={selectedSpriteIds.length === 0}
                  >
                    清空已选
                  </button>
                  <button className="ghost-button" onClick={exitSelectionMode}>
                    退出选择模式
                  </button>
                </div>
              </>
            ) : (
              <>
                {selectedSprite ? (
                  <div className="selected-sprite">
                    <img src={selectedSprite.previewDataUrl} alt={selectedSprite.id} />
                    <div>
                      <h3>{selectedSprite.id}</h3>
                      <p>
                        {selectedSprite.width} x {selectedSprite.height} px
                      </p>
                      <p>面积 {selectedSprite.area} px</p>
                    </div>
                  </div>
                ) : (
                  <p className="muted">点击左侧识别框查看详情。</p>
                )}
                <div className="action-stack">
                  {groups.map((group) => (
                    <button
                      key={group.id}
                      className="group-assign-button"
                      onClick={() => selectedSprite && reassignSprite(selectedSprite.id, group.id)}
                      disabled={!selectedSprite}
                    >
                      分到 {group.label}
                    </button>
                  ))}
                  <button
                    className="ghost-button"
                    onClick={() =>
                      selectedSprite &&
                      (ignoredSpriteIds.includes(selectedSprite.id)
                        ? restoreSprite(selectedSprite.id)
                        : ignoreSprite(selectedSprite.id))
                    }
                    disabled={!selectedSprite}
                  >
                    {selectedSprite && ignoredSpriteIds.includes(selectedSprite.id) ? "恢复精灵" : "忽略精灵"}
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="panel-card">
            <div className="section-head tight">
              <div>
                <p className="section-kicker">尺寸分组</p>
                <h2>标准表格参数</h2>
              </div>
            </div>

            <div className="group-create-form">
              <input
                type="number"
                min="1"
                value={groupDraft.width}
                onChange={(event) =>
                  setGroupDraft((current) => ({ ...current, width: event.target.value }))
                }
                placeholder="宽"
              />
              <input
                type="number"
                min="1"
                value={groupDraft.height}
                onChange={(event) =>
                  setGroupDraft((current) => ({ ...current, height: event.target.value }))
                }
                placeholder="高"
              />
              <input
                type="number"
                min="1"
                value={groupDraft.columns}
                onChange={(event) =>
                  setGroupDraft((current) => ({ ...current, columns: event.target.value }))
                }
                placeholder="列数"
              />
              <button className="secondary-button" onClick={addGroup}>
                新增分组
              </button>
            </div>

            <div className="group-list">
              {groups.map((group) => (
                <article key={group.id} className="group-card">
                  <div className="group-card-header">
                    <div>
                      <h3>{group.label}</h3>
                      <p>{group.spriteIds.length} 个精灵</p>
                    </div>
                    <button className="primary-mini" onClick={() => exportGroup(group)}>
                      导出
                    </button>
                  </div>

                  <label className="inline-input">
                    固定列数
                    <input
                      type="number"
                      min="1"
                      value={group.columnCount}
                      onChange={(event) =>
                        updateGroupColumns(group.id, Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="inline-input checkbox-inline">
                    <input
                      type="checkbox"
                      checked={edgeCleanupMode === "outline_strong"}
                      onChange={(event) =>
                        setEdgeCleanupMode(event.target.checked ? "outline_strong" : "standard")
                      }
                    />
                    强去边（黑描边素材）
                  </label>
                  <p className="muted">
                    自动按比例重采样，最近邻缩放，居中透明留白；
                    {edgeCleanupMode === "outline_strong"
                      ? "导出时将先做黑描边强去边，左侧预览不会同步变化。"
                      : "识别时清理白底白边，导出时继续做标准边缘净化。"}
                  </p>

                  <div className="thumbnail-strip">
                    {group.spriteIds.length > 0 ? (
                      group.spriteIds.slice(0, 12).map((spriteId) => {
                        const sprite = sprites.find((item) => item.id === spriteId);
                        if (!sprite) {
                          return null;
                        }
                        return <img key={spriteId} src={sprite.previewDataUrl} alt={spriteId} />;
                      })
                    ) : (
                      <p className="muted">还没有分配精灵</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel-card status-panel">
            <p className="section-kicker">运行状态</p>
            <p>{message}</p>
            <p className="muted">
              当前导出模式：
              {edgeCleanupMode === "outline_strong" ? "黑描边强去边（仅导出时生效）" : "标准模式"}
            </p>
            <div className="legend">
              <span className="legend-item waiting">待处理</span>
              <span className="legend-item grouped">已分组</span>
              <span className="legend-item ignored">已忽略</span>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
