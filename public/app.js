const canvasList = document.querySelector("#canvasList");
const newCanvasButton = document.querySelector("#newCanvasButton");
const activeCanvasName = document.querySelector("#activeCanvasName");
const renameCanvasButton = document.querySelector("#renameCanvasButton");
const exportCanvasButton = document.querySelector("#exportCanvasButton");
const modelInfo = document.querySelector("#modelInfo");
const canvasViewport = document.querySelector("#canvasViewport");
const canvasWorld = document.querySelector("#canvasWorld");
const targetMarker = document.querySelector("#targetMarker");
const canvasHint = document.querySelector("#canvasHint");
const zoomInfo = document.querySelector("#zoomInfo");
const targetInfo = document.querySelector("#targetInfo");
const positionText = document.querySelector("#positionText");
const form = document.querySelector("#generateForm");
const promptInput = document.querySelector("#prompt");
const imageModelSelect = document.querySelector("#imageModelSelect");
const optimizePromptButton = document.querySelector("#optimizePromptButton");
const promptOptimizeStatus = document.querySelector("#promptOptimizeStatus");
const promptSuggestion = document.querySelector("#promptSuggestion");
const optimizedPromptText = document.querySelector("#optimizedPromptText");
const optimizedPromptChanges = document.querySelector("#optimizedPromptChanges");
const acceptPromptButton = document.querySelector("#acceptPromptButton");
const rejectPromptButton = document.querySelector("#rejectPromptButton");
const referenceImageInput = document.querySelector("#referenceImageInput");
const referencePreview = document.querySelector("#referencePreview");
const referencePreviewImage = document.querySelector("#referencePreviewImage");
const clearReferenceButton = document.querySelector("#clearReferenceButton");
const useSelectedImageButton = document.querySelector("#useSelectedImageButton");
const sizeInput = document.querySelector("#size");
const generateButton = document.querySelector("#generateButton");
const statusMessage = document.querySelector("#statusMessage");
const evaluateImageButton = document.querySelector("#evaluateImageButton");
const evaluationResult = document.querySelector("#evaluationResult");
const insightsMeta = document.querySelector("#insightsMeta");
const insightsStatus = document.querySelector("#insightsStatus");
const insightsList = document.querySelector("#insightsList");
const refineInsightsButton = document.querySelector("#refineInsightsButton");
const buildTemplateButton = document.querySelector("#buildTemplateButton");
const styleSummary = document.querySelector("#styleSummary");
const historyList = document.querySelector("#historyList");
const historyAllButton = document.querySelector("#historyAllButton");
const historyCurrentButton = document.querySelector("#historyCurrentButton");

const MIN_SCALE = 0.12;
const MAX_SCALE = 4;
const VIEWPORT_SAVE_DELAY = 300;

let appState = { canvases: [], images: [], history: [], config: null };
let activeCanvasId = localStorage.getItem("activeCanvasId");
let selectedTarget = null;
let selectedImageId = null;
let selectedImageIds = new Set();
let historyFilter = "all";
let promptInsights = null;
let aiInsights = null;
let expandedInsightGroups = new Set();
let expandedHistoryPrompts = new Set();
let refineConfirmed = localStorage.getItem("promptRefineConfirmed") === "true";
let viewportSaveTimer = 0;
let interaction = null;
let placeholder = null;
let referenceImageDataUrl = "";
let optimizedPromptCandidate = "";

init();

async function init() {
  try {
    const state = await apiGet("/api/state");
    appState = state;
    if (!appState.canvases.some(canvas => canvas.id === activeCanvasId)) {
      activeCanvasId = appState.canvases[0]?.id || null;
    }
    if (activeCanvasId) localStorage.setItem("activeCanvasId", activeCanvasId);
    await refreshPromptInsights();
    renderAll();
  } catch (error) {
    showStatus(`初始化失败：${error.message}`, "error");
  }
}

newCanvasButton.addEventListener("click", async () => {
  setControlBusy(newCanvasButton, true);
  try {
    const data = await apiJson("/api/canvases", { method: "POST", body: {} });
    appState.canvases.push(data.canvas);
    setActiveCanvas(data.canvas.id);
  } catch (error) {
    showStatus(`新建画布失败：${error.message}`, "error");
  } finally {
    setControlBusy(newCanvasButton, false);
  }
});

renameCanvasButton.addEventListener("click", renameActiveCanvas);
exportCanvasButton.addEventListener("click", exportActiveCanvas);
optimizePromptButton.addEventListener("click", optimizeCurrentPrompt);
acceptPromptButton.addEventListener("click", acceptOptimizedPrompt);
rejectPromptButton.addEventListener("click", rejectOptimizedPrompt);
evaluateImageButton.addEventListener("click", evaluateSelectedImage);
referenceImageInput.addEventListener("change", handleReferenceImageChange);
clearReferenceButton.addEventListener("click", clearReferenceImage);
useSelectedImageButton.addEventListener("click", useSelectedImageAsReference);
imageModelSelect.addEventListener("change", () => {
  localStorage.setItem("imageProvider", imageModelSelect.value);
  const selectedModel = getSelectedImageModel();
  if (selectedModel) modelInfo.textContent = `${selectedModel.label || selectedModel.provider} · ${selectedModel.model}`;
});

canvasViewport.addEventListener("pointerdown", event => {
  if (event.button !== 0 || event.target.closest(".image-node")) return;
  canvasViewport.setPointerCapture(event.pointerId);
  const viewport = getActiveViewport();
  interaction = {
    type: "pan",
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: viewport.x,
    startY: viewport.y,
    moved: false
  };
});

canvasViewport.addEventListener("pointermove", event => {
  if (!interaction || interaction.type !== "pan" || interaction.pointerId !== event.pointerId) return;
  const dx = event.clientX - interaction.startClientX;
  const dy = event.clientY - interaction.startClientY;
  if (Math.abs(dx) + Math.abs(dy) > 4) interaction.moved = true;
  if (!interaction.moved) return;
  const viewport = getActiveViewport();
  viewport.x = interaction.startX + dx;
  viewport.y = interaction.startY + dy;
  renderViewport();
});

canvasViewport.addEventListener("pointerup", event => {
  if (!interaction || interaction.type !== "pan" || interaction.pointerId !== event.pointerId) return;
  canvasViewport.releasePointerCapture(event.pointerId);
  if (interaction.moved) {
    saveActiveViewport();
  } else {
    selectedTarget = screenToWorld(event.clientX, event.clientY);
    renderTarget();
  }
  interaction = null;
});

canvasViewport.addEventListener("pointercancel", () => {
  interaction = null;
});

canvasViewport.addEventListener("wheel", event => {
  event.preventDefault();
  const viewport = getActiveViewport();
  const rect = canvasViewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const before = screenPointToWorld(mouseX, mouseY);
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  viewport.scale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
  viewport.x = mouseX - before.x * viewport.scale;
  viewport.y = mouseY - before.y * viewport.scale;
  renderViewport();
  queueViewportSave();
}, { passive: false });

form.addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!selectedTarget) {
    showStatus("请先点击画布上的生成位置。", "error");
    return;
  }
  if (!prompt) {
    showStatus("请输入提示词。", "error");
    promptInput.focus();
    return;
  }

  const canvasId = activeCanvasId;
  const target = { ...selectedTarget };
  placeholder = {
    id: "placeholder",
    canvasId,
    x: target.x,
    y: target.y,
    width: 280,
    height: 280,
    prompt
  };
  renderImages();
  setGenerating(true);
  showStatus("正在生成图片...", "info");

  try {
    const data = await apiJson("/api/generate", {
      method: "POST",
      body: {
        canvasId,
        prompt,
        x: target.x,
        y: target.y,
        provider: imageModelSelect.value,
        size: sizeInput.value,
        referenceImages: referenceImageDataUrl ? [referenceImageDataUrl] : []
      }
    });
    appState.images.push(data.image);
    appState.history.push(data.history);
    selectedTarget = null;
    selectSingleImage(data.image.id);
    promptInput.value = "";
    clearReferenceImage();
    await refreshPromptInsights();
    showStatus("生成完成。", "success");
  } catch (error) {
    showStatus(`生成失败：${error.message}`, "error");
  } finally {
    placeholder = null;
    setGenerating(false);
    renderAll();
  }
});

historyAllButton.addEventListener("click", () => setHistoryFilter("all"));
historyCurrentButton.addEventListener("click", () => setHistoryFilter("current"));
refineInsightsButton.addEventListener("click", refinePromptInsights);
buildTemplateButton.addEventListener("click", insertPromptTemplate);

function renderAll() {
  renderChrome();
  renderCanvases();
  renderViewport();
  renderImages();
  renderTarget();
  renderInsights();
  renderHistory();
}

function getPrimarySelectedImage() {
  if (selectedImageIds.size !== 1) return null;
  const imageId = Array.from(selectedImageIds)[0];
  return appState.images.find(item => item.id === imageId) || null;
}

function getLastSelectedImageId() {
  const values = Array.from(selectedImageIds);
  return values.length ? values[values.length - 1] : null;
}

function syncPrimarySelection() {
  if (selectedImageId && selectedImageIds.has(selectedImageId)) return;
  selectedImageId = getLastSelectedImageId();
}

function selectSingleImage(imageId) {
  selectedImageIds = new Set([imageId]);
  selectedImageId = imageId;
}

function toggleImageSelection(imageId) {
  if (selectedImageIds.has(imageId)) {
    selectedImageIds.delete(imageId);
    if (selectedImageId === imageId) selectedImageId = getLastSelectedImageId();
  } else {
    selectedImageIds.add(imageId);
    selectedImageId = imageId;
  }
  syncPrimarySelection();
}

function clearImageSelection() {
  selectedImageIds = new Set();
  selectedImageId = null;
}

function updateImageSelectionClasses() {
  document.querySelectorAll(".image-node").forEach(node => {
    node.classList.toggle("is-selected", selectedImageIds.has(node.dataset.imageId));
  });
}

function syncImageModelOptions() {
  const models = Array.isArray(appState.config?.imageModels) ? appState.config.imageModels : [];
  if (models.length === 0 || imageModelSelect.dataset.loaded === "true") return;
  const selected = localStorage.getItem("imageProvider") || appState.config.defaultImageProvider || "seedream";
  imageModelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.provider;
    option.textContent = `${model.label}${model.available ? "" : "（未配置 Key）"}`;
    option.disabled = !model.available;
    imageModelSelect.append(option);
  }
  imageModelSelect.value = models.some(model => model.provider === selected && model.available)
    ? selected
    : (models.find(model => model.available)?.provider || "seedream");
  imageModelSelect.dataset.loaded = "true";
}

function getSelectedImageModel() {
  const models = Array.isArray(appState.config?.imageModels) ? appState.config.imageModels : [];
  return models.find(model => model.provider === imageModelSelect.value) || null;
}

function renderChrome() {
  syncImageModelOptions();
  const canvas = getActiveCanvas();
  activeCanvasName.textContent = canvas?.name || "画布";
  modelInfo.textContent = appState.config
    ? `${appState.config.imageModel} · ${appState.config.imageSize}`
    : "模型配置未读取";
}

function renderCanvases() {
  canvasList.replaceChildren();
  for (const canvas of appState.canvases) {
    const count = appState.images.filter(image => image.canvasId === canvas.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `canvas-item${canvas.id === activeCanvasId ? " is-active" : ""}`;
    button.innerHTML = `<span>${escapeHtml(canvas.name)}</span><small>${count} 张图片</small>`;
    button.addEventListener("click", () => setActiveCanvas(canvas.id));
    canvasList.append(button);
  }
}

function renderViewport() {
  const viewport = getActiveViewport();
  canvasWorld.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
  const gridSize = Math.max(8, 40 * viewport.scale);
  canvasViewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
  canvasViewport.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
  zoomInfo.textContent = `${Math.round(viewport.scale * 100)}%`;
  if (selectedTarget) {
    targetMarker.style.transform = `translate(${viewport.x + selectedTarget.x * viewport.scale}px, ${viewport.y + selectedTarget.y * viewport.scale}px)`;
  }
}

function renderImages() {
  canvasWorld.replaceChildren();
  const visibleImages = appState.images.filter(image => image.canvasId === activeCanvasId);
  canvasHint.hidden = visibleImages.length > 0 || Boolean(placeholder);

  for (const image of visibleImages) {
    canvasWorld.append(createImageNode(image));
  }
  if (placeholder?.canvasId === activeCanvasId) {
    canvasWorld.append(createPlaceholderNode(placeholder));
  }
}

function createImageNode(image) {
  const node = document.createElement("article");
  node.className = `image-node${selectedImageIds.has(image.id) ? " is-selected" : ""}`;
  node.dataset.imageId = image.id;
  node.style.left = `${image.x}px`;
  node.style.top = `${image.y}px`;
  node.style.width = `${image.width}px`;
  node.style.height = `${image.height}px`;
  node.innerHTML = `
    <img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.prompt)}" draggable="false">
    <div class="image-caption">${image.referenceImageCount > 0 ? "图生图 · " : ""}${escapeHtml(image.prompt)}</div>
    <button class="delete-image-button" type="button" aria-label="删除图片">×</button>
    <button class="resize-handle" type="button" aria-label="缩放图片"></button>
  `;

  node.addEventListener("pointerdown", event => startImageDrag(event, image.id));
  const deleteButton = node.querySelector(".delete-image-button");
  deleteButton.addEventListener("pointerdown", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  deleteButton.addEventListener("click", event => deleteImage(event, image.id));
  node.querySelector(".resize-handle").addEventListener("pointerdown", event => startImageResize(event, image.id));
  return node;
}

function createPlaceholderNode(item) {
  const node = document.createElement("article");
  node.className = "image-node placeholder-node";
  node.style.left = `${item.x}px`;
  node.style.top = `${item.y}px`;
  node.style.width = `${item.width}px`;
  node.style.height = `${item.height}px`;
  node.innerHTML = `<div class="placeholder-spinner"></div><span>生成中...</span>`;
  return node;
}

function renderTarget() {
  if (!selectedTarget) {
    targetMarker.hidden = true;
    targetInfo.textContent = "点击画布选择生成位置";
    positionText.textContent = "未选择位置";
    generateButton.disabled = true;
    return;
  }
  const viewport = getActiveViewport();
  targetMarker.hidden = false;
  targetMarker.style.transform = `translate(${viewport.x + selectedTarget.x * viewport.scale}px, ${viewport.y + selectedTarget.y * viewport.scale}px)`;
  targetInfo.textContent = `生成位置：${Math.round(selectedTarget.x)}, ${Math.round(selectedTarget.y)}`;
  positionText.textContent = `${Math.round(selectedTarget.x)}, ${Math.round(selectedTarget.y)}`;
  generateButton.disabled = false;
}

function renderHistory() {
  historyAllButton.classList.toggle("is-active", historyFilter === "all");
  historyCurrentButton.classList.toggle("is-active", historyFilter === "current");
  const rows = appState.history
    .filter(item => historyFilter === "all" || item.canvasId === activeCanvasId)
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  historyList.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "还没有生成记录";
    historyList.append(empty);
    return;
  }

  for (const item of rows) {
    const canvas = appState.canvases.find(entry => entry.id === item.canvasId);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-item${selectedImageIds.has(item.imageId) ? " is-selected" : ""}${item.deletedAt ? " is-deleted" : ""}`;
    button.innerHTML = `
      <span>${escapeHtml(item.prompt)}</span>
      <small>${escapeHtml(canvas?.name || "未知画布")} · ${item.referenceImageCount > 0 ? "图生图 · " : ""}${formatTime(item.createdAt)}${item.deletedAt ? " · 图片已删除" : ""}</small>
    `;
    button.addEventListener("click", () => focusHistoryItem(item));
    historyList.append(createHistoryCard(item));
    button.remove();
  }
}

function createHistoryCard(item) {
  const canvas = appState.canvases.find(entry => entry.id === item.canvasId);
  const isExpanded = expandedHistoryPrompts.has(item.id);
  const isLong = item.prompt.length > 64;
  const card = document.createElement("article");
  card.className = `history-item${selectedImageIds.has(item.imageId) ? " is-selected" : ""}${item.deletedAt ? " is-deleted" : ""}${isExpanded ? " is-expanded" : ""}`;

  const promptButton = document.createElement("button");
  promptButton.type = "button";
  promptButton.className = "history-prompt";
  promptButton.innerHTML = `<span>${escapeHtml(item.prompt)}</span>`;
  promptButton.addEventListener("click", () => focusHistoryItem(item));

  const meta = document.createElement("small");
  meta.textContent = `${canvas?.name || "未知画布"} · ${item.referenceImageCount > 0 ? "图生图 · " : ""}${formatTime(item.createdAt)}${item.deletedAt ? " · 图片已删除" : ""}`;

  const actions = document.createElement("div");
  actions.className = "history-actions";
  if (isLong) {
    const moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.className = "text-button";
    moreButton.textContent = isExpanded ? "收起" : "更多";
    moreButton.addEventListener("click", () => {
      if (expandedHistoryPrompts.has(item.id)) {
        expandedHistoryPrompts.delete(item.id);
      } else {
        expandedHistoryPrompts.add(item.id);
      }
      renderHistory();
    });
    actions.append(moreButton);
  }

  const useButton = document.createElement("button");
  useButton.type = "button";
  useButton.className = "text-button";
  useButton.textContent = "使用";
  useButton.addEventListener("click", () => useHistoryPrompt(item.prompt));
  actions.append(useButton);

  card.append(promptButton, meta, actions);
  return card;
}

function useHistoryPrompt(prompt) {
  promptInput.value = prompt;
  promptInput.focus();
  showStatus("已填入历史提示词。", "success");
}

async function optimizeCurrentPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showStatus("请输入要优化的提示词。", "error");
    promptInput.focus();
    return;
  }

  setControlBusy(optimizePromptButton, true);
  promptOptimizeStatus.textContent = "优化中...";
  promptSuggestion.hidden = true;
  optimizedPromptCandidate = "";

  try {
    const data = await apiJson("/api/prompts/optimize", {
      method: "POST",
      body: {
        prompt,
        commonTerms: getTopInsightTerms()
      }
    });
    optimizedPromptCandidate = data.optimizedPrompt || "";
    optimizedPromptText.textContent = optimizedPromptCandidate;
    optimizedPromptChanges.replaceChildren();
    for (const change of data.changes || []) {
      const item = document.createElement("li");
      item.textContent = change;
      optimizedPromptChanges.append(item);
    }
    if (data.optionalNegativePrompt) {
      const item = document.createElement("li");
      item.textContent = `避免：${data.optionalNegativePrompt}`;
      optimizedPromptChanges.append(item);
    }
    promptSuggestion.hidden = false;
    promptOptimizeStatus.textContent = "已生成候选";
  } catch (error) {
    promptOptimizeStatus.textContent = "";
    showStatus(`提示词优化失败：${error.message}`, "error");
  } finally {
    setControlBusy(optimizePromptButton, false);
  }
}

function acceptOptimizedPrompt() {
  if (!optimizedPromptCandidate) return;
  promptInput.value = optimizedPromptCandidate;
  promptSuggestion.hidden = true;
  promptOptimizeStatus.textContent = "已采用";
  promptInput.focus();
}

function rejectOptimizedPrompt() {
  optimizedPromptCandidate = "";
  promptSuggestion.hidden = true;
  promptOptimizeStatus.textContent = "未采用";
  promptInput.focus();
}

async function evaluateSelectedImage() {
  const image = getPrimarySelectedImage();
  if (!image) {
    if (selectedImageIds.size > 1) {
      showStatus("请只选中一张图片后再评价。", "error");
      return;
    }
    showStatus("请先在画布上选中一张图片。", "error");
    return;
  }

  setControlBusy(evaluateImageButton, true);
  evaluationResult.textContent = "千问正在评价图片...";
  try {
    const data = await apiJson(`/api/images/${encodeURIComponent(image.id)}/evaluate`, {
      method: "POST",
      body: {
        prompt: image.prompt
      }
    });
    evaluationResult.textContent = data.evaluation || "没有返回评价内容。";
  } catch (error) {
    evaluationResult.textContent = "评价失败。";
    showStatus(`图片评价失败：${error.message}`, "error");
  } finally {
    setControlBusy(evaluateImageButton, false);
  }
}

function getTopInsightTerms() {
  const groups = promptInsights?.groups || [];
  const terms = [];
  for (const group of groups) {
    for (const item of group.items || []) {
      if (item.text) terms.push(item.text);
    }
  }
  return terms.slice(0, 20);
}

async function handleReferenceImageChange() {
  const file = referenceImageInput.files?.[0];
  if (!file) {
    clearReferenceImage();
    return;
  }
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    showStatus("参考图只支持 PNG、JPG、WEBP。", "error");
    clearReferenceImage();
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showStatus("参考图不能超过 10MB。", "error");
    clearReferenceImage();
    return;
  }

  try {
    referenceImageDataUrl = await readFileAsDataUrl(file);
    referencePreviewImage.src = referenceImageDataUrl;
    referencePreview.hidden = false;
    showStatus("参考图已加载，将用于本次图生图。", "success");
  } catch (error) {
    showStatus(`读取参考图失败：${error.message}`, "error");
    clearReferenceImage();
  }
}

function clearReferenceImage() {
  referenceImageDataUrl = "";
  referenceImageInput.value = "";
  referencePreviewImage.removeAttribute("src");
  referencePreview.hidden = true;
}

async function useSelectedImageAsReference() {
  const image = getPrimarySelectedImage();
  if (!image) {
    if (selectedImageIds.size > 1) {
      showStatus("请只选中一张图片作为参考图。", "error");
      return;
    }
    showStatus("请先在画布上选中一张图片。", "error");
    return;
  }
  try {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error("图片读取失败");
    const blob = await response.blob();
    referenceImageDataUrl = await readBlobAsDataUrl(blob);
    referencePreviewImage.src = referenceImageDataUrl;
    referencePreview.hidden = false;
    showStatus("已把选中图片设为参考图。", "success");
  } catch (error) {
    showStatus(`设置参考图失败：${error.message}`, "error");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

function renderInsights() {
  insightsList.replaceChildren();
  styleSummary.hidden = true;
  styleSummary.textContent = "";

  const activeInsights = aiInsights || promptInsights;
  const isAi = Boolean(aiInsights);
  if (!activeInsights) {
    insightsMeta.textContent = "正在分析...";
    insightsStatus.textContent = "";
    return;
  }

  const groups = Array.isArray(activeInsights.groups) ? activeInsights.groups : [];
  const total = promptInsights?.totalPrompts ?? 0;
  insightsMeta.textContent = `${historyFilter === "all" ? "全部画布" : "当前画布"} · ${total} 条历史`;
  insightsStatus.textContent = isAi ? "AI 结果" : "本地统计";

  if (isAi && aiInsights.styleSummary) {
    styleSummary.hidden = false;
    styleSummary.textContent = aiInsights.styleSummary;
  }

  const visibleGroups = groups.filter(group => {
    const items = Array.isArray(group.items) ? group.items : [];
    const moreItems = Array.isArray(group.moreItems) ? group.moreItems : [];
    return items.length > 0 || moreItems.length > 0;
  });
  if (visibleGroups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "历史提示词还不够，继续生成后会自动整理共性。";
    insightsList.append(empty);
    return;
  }

  for (const group of visibleGroups) {
    const items = Array.isArray(group.items) ? group.items : [];
    const moreItems = Array.isArray(group.moreItems) ? group.moreItems : [];
    const groupKey = group.key || group.label || "other";
    const expanded = expandedInsightGroups.has(groupKey);
    const displayItems = expanded ? items.concat(moreItems) : items;

    const section = document.createElement("section");
    section.className = "insight-group";

    const header = document.createElement("header");
    header.innerHTML = `<strong>${escapeHtml(group.label || group.key)}</strong>`;
    const headerActions = document.createElement("div");
    headerActions.className = "insight-group-actions";
    if (moreItems.length > 0) {
      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "text-button";
      moreButton.textContent = expanded ? "收起" : `更多 ${moreItems.length}`;
      moreButton.addEventListener("click", () => {
        if (expandedInsightGroups.has(groupKey)) {
          expandedInsightGroups.delete(groupKey);
        } else {
          expandedInsightGroups.add(groupKey);
        }
        renderInsights();
      });
      headerActions.append(moreButton);
    }
    const insertGroupButton = document.createElement("button");
    insertGroupButton.type = "button";
    insertGroupButton.className = "text-button";
    insertGroupButton.textContent = "插入本组";
    insertGroupButton.disabled = displayItems.length === 0;
    insertGroupButton.addEventListener("click", () => appendPromptParts(displayItems.map(item => item.text)));
    headerActions.append(insertGroupButton);
    header.append(headerActions);
    section.append(header);

    const chips = document.createElement("div");
    chips.className = "insight-chips";
    if (displayItems.length === 0) {
      const hint = document.createElement("span");
      hint.className = "insight-more-hint";
      hint.textContent = "点“更多”查看 1 次候选词";
      chips.append(hint);
    }
    for (const item of displayItems) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `insight-chip${item.lowFrequency ? " is-low" : ""}`;
      chip.title = item.lowFrequency ? "低频候选" : `出现 ${item.count} 次`;
      chip.innerHTML = `<span>${escapeHtml(item.text)}</span><small>${item.lowFrequency ? "低频" : item.count}</small>`;
      chip.addEventListener("click", () => appendPromptParts([item.text]));
      chips.append(chip);
    }
    section.append(chips);
    insightsList.append(section);
  }
}

async function refreshPromptInsights() {
  if (!activeCanvasId) return;
  const scope = historyFilter === "current" ? "current" : "all";
  const query = new URLSearchParams({ scope, canvasId: activeCanvasId });
  try {
    promptInsights = await apiGet(`/api/prompt-insights?${query.toString()}`);
    aiInsights = null;
    renderInsights();
  } catch (error) {
    insightsStatus.textContent = "分析失败";
    insightsMeta.textContent = error.message;
  }
}

async function refinePromptInsights() {
  if (!promptInsights || promptInsights.totalPrompts === 0) {
    showStatus("没有可精修的历史提示词。", "error");
    return;
  }

  if (!refineConfirmed) {
    const ok = window.confirm("AI 精修会把当前范围内的历史提示词文本发送到 DeepSeek 做归纳，不会发送图片文件。确认继续？");
    if (!ok) return;
    refineConfirmed = true;
    localStorage.setItem("promptRefineConfirmed", "true");
  }

  setControlBusy(refineInsightsButton, true);
  insightsStatus.textContent = "AI 精修中...";
  try {
    const prompts = getInsightPrompts();
    aiInsights = await apiJson("/api/prompt-insights/refine", {
      method: "POST",
      body: {
        scope: historyFilter === "current" ? "current" : "all",
        canvasId: activeCanvasId,
        groups: promptInsights.groups,
        prompts
      }
    });
    localStorage.setItem("lastPromptAiInsights", JSON.stringify({
      canvasId: activeCanvasId,
      scope: historyFilter,
      data: aiInsights,
      savedAt: new Date().toISOString()
    }));
    renderInsights();
  } catch (error) {
    aiInsights = null;
    renderInsights();
    showStatus(`AI 精修失败：${error.message}`, "error");
  } finally {
    setControlBusy(refineInsightsButton, false);
  }
}

function insertPromptTemplate() {
  const activeInsights = aiInsights || promptInsights;
  const template = aiInsights?.recommendedTemplate || activeInsights?.template || buildClientTemplate(activeInsights?.groups || []);
  if (!template) {
    showStatus("还没有可生成的模板。", "error");
    return;
  }
  promptInput.value = template;
  promptInput.focus();
}

function appendPromptParts(parts) {
  const cleanParts = parts.map(item => String(item || "").trim()).filter(Boolean);
  if (cleanParts.length === 0) return;
  const current = promptInput.value.trim();
  promptInput.value = current ? `${current}，${cleanParts.join("，")}` : cleanParts.join("，");
  promptInput.focus();
}

function getInsightPrompts() {
  return appState.history
    .filter(item => item.prompt && (historyFilter !== "current" || item.canvasId === activeCanvasId))
    .map(item => item.prompt);
}

function buildClientTemplate(groups) {
  const order = ["style", "subject", "feature", "background", "quality"];
  const parts = [];
  for (const key of order) {
    const group = groups.find(item => item.key === key);
    const text = group?.items?.[0]?.text;
    if (text) parts.push(text);
  }
  return parts.join("，");
}

async function renameActiveCanvas() {
  const canvas = getActiveCanvas();
  if (!canvas) return;
  const name = window.prompt("输入新的画布名称", canvas.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showStatus("画布名称不能为空。", "error");
    return;
  }
  try {
    const data = await apiJson(`/api/canvases/${encodeURIComponent(canvas.id)}`, {
      method: "PATCH",
      body: { name: trimmed }
    });
    Object.assign(canvas, data.canvas);
    showStatus("画布已重命名。", "success");
    renderAll();
  } catch (error) {
    showStatus(`重命名失败：${error.message}`, "error");
  }
}

async function deleteImage(event, imageId) {
  event.preventDefault();
  event.stopPropagation();
  const image = appState.images.find(item => item.id === imageId);
  if (!image) return;
  if (!window.confirm("确认删除这张图片？历史提示词会保留并标记为已删除。")) return;

  try {
    await apiDelete(`/api/images/${encodeURIComponent(imageId)}`);
    appState.images = appState.images.filter(item => item.id !== imageId);
    appState.history = appState.history.map(item => item.imageId === imageId
      ? { ...item, deletedAt: new Date().toISOString() }
      : item);
    selectedImageIds.delete(imageId);
    if (selectedImageId === imageId) selectedImageId = getLastSelectedImageId();
    syncPrimarySelection();
    await refreshPromptInsights();
    showStatus("图片已删除。", "success");
    renderAll();
  } catch (error) {
    showStatus(`删除失败：${error.message}`, "error");
  }
}

async function exportActiveCanvas() {
  const canvas = getActiveCanvas();
  const images = appState.images.filter(image => image.canvasId === activeCanvasId);
  if (!canvas || images.length === 0) {
    showStatus("当前画布没有可导出的图片。", "error");
    return;
  }

  setControlBusy(exportCanvasButton, true);
  showStatus("正在导出画布...", "info");
  try {
    const padding = 80;
    const bounds = getImagesBounds(images);
    const scale = Math.min(2, Math.max(1, 2200 / Math.max(bounds.width + padding * 2, bounds.height + padding * 2)));
    const output = document.createElement("canvas");
    output.width = Math.ceil((bounds.width + padding * 2) * scale);
    output.height = Math.ceil((bounds.height + padding * 2) * scale);
    const ctx = output.getContext("2d");

    ctx.fillStyle = "#f4f7fa";
    ctx.fillRect(0, 0, output.width, output.height);
    drawExportGrid(ctx, output.width, output.height, scale);

    for (const image of images) {
      const bitmap = await loadImage(image.url);
      const x = (image.x - bounds.left + padding) * scale;
      const y = (image.y - bounds.top + padding) * scale;
      const width = image.width * scale;
      const height = image.height * scale;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, width, height);
      ctx.drawImage(bitmap, x, y, width, height);
      drawCaption(ctx, image.prompt, x, y + height, width, scale);
    }

    const filename = `${sanitizeFilename(canvas.name)}-${Date.now()}.png`;
    const url = output.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    showStatus("画布已导出。", "success");
  } catch (error) {
    showStatus(`导出失败：${error.message}`, "error");
  } finally {
    setControlBusy(exportCanvasButton, false);
  }
}

function startImageDrag(event, imageId) {
  if (event.button !== 0 || event.target.classList.contains("resize-handle")) return;
  event.stopPropagation();
  const image = appState.images.find(item => item.id === imageId);
  if (!image) return;
  const wasSelected = selectedImageIds.has(imageId);
  if (!event.shiftKey && !wasSelected) {
    selectSingleImage(imageId);
    updateImageSelectionClasses();
    renderHistory();
  }
  const node = event.currentTarget;
  node.setPointerCapture(event.pointerId);
  interaction = {
    type: "image-drag",
    pointerId: event.pointerId,
    imageId,
    node,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: image.x,
    startY: image.y,
    wasSelected,
    shiftKey: event.shiftKey,
    moved: false
  };
  node.addEventListener("pointermove", handleImagePointerMove);
  node.addEventListener("pointerup", finishImagePointerAction);
  node.addEventListener("pointercancel", finishImagePointerAction);
}

function startImageResize(event, imageId) {
  if (event.button !== 0) return;
  event.stopPropagation();
  const image = appState.images.find(item => item.id === imageId);
  if (!image) return;
  if (!selectedImageIds.has(imageId)) {
    selectSingleImage(imageId);
  } else {
    selectedImageId = imageId;
  }
  const node = event.currentTarget.closest(".image-node");
  node.setPointerCapture(event.pointerId);
  interaction = {
    type: "image-resize",
    pointerId: event.pointerId,
    imageId,
    node,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startWidth: image.width,
    startHeight: image.height,
    aspect: image.height / image.width
  };
  updateImageSelectionClasses();
  renderHistory();
  node.addEventListener("pointermove", handleImagePointerMove);
  node.addEventListener("pointerup", finishImagePointerAction);
  node.addEventListener("pointercancel", finishImagePointerAction);
}

function handleImagePointerMove(event) {
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const image = appState.images.find(item => item.id === interaction.imageId);
  if (!image) return;
  const viewport = getActiveViewport();
  const dx = (event.clientX - interaction.startClientX) / viewport.scale;
  const dy = (event.clientY - interaction.startClientY) / viewport.scale;

  if (interaction.type === "image-drag") {
    if (Math.abs(dx) + Math.abs(dy) > 2) interaction.moved = true;
    image.x = interaction.startX + dx;
    image.y = interaction.startY + dy;
    interaction.node.style.left = `${image.x}px`;
    interaction.node.style.top = `${image.y}px`;
  } else {
    const nextWidth = Math.max(120, interaction.startWidth + dx);
    image.width = nextWidth;
    image.height = Math.max(120, nextWidth * interaction.aspect);
    interaction.node.style.width = `${image.width}px`;
    interaction.node.style.height = `${image.height}px`;
  }
}

async function finishImagePointerAction(event) {
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  const done = interaction;
  done.node.releasePointerCapture(event.pointerId);
  done.node.removeEventListener("pointermove", handleImagePointerMove);
  done.node.removeEventListener("pointerup", finishImagePointerAction);
  done.node.removeEventListener("pointercancel", finishImagePointerAction);
  interaction = null;

  const image = appState.images.find(item => item.id === done.imageId);
  if (!image) return;
  if (done.type === "image-drag" && !done.moved) {
    image.x = done.startX;
    image.y = done.startY;
    if (done.shiftKey) {
      toggleImageSelection(done.imageId);
    } else if (done.wasSelected && selectedImageIds.size === 1) {
      clearImageSelection();
    } else {
      selectSingleImage(done.imageId);
    }
    renderAll();
    return;
  }
  if (done.type === "image-drag" && done.shiftKey && !done.wasSelected) {
    selectSingleImage(done.imageId);
  }
  try {
    const data = await apiJson(`/api/images/${encodeURIComponent(image.id)}`, {
      method: "PATCH",
      body: {
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height
      }
    });
    Object.assign(image, data.image);
  } catch (error) {
    showStatus(`保存图片位置失败：${error.message}`, "error");
  }
}

function focusHistoryItem(item) {
  if (item.deletedAt) {
    showStatus("这条历史对应的图片已删除。", "info");
    return;
  }
  const image = appState.images.find(entry => entry.id === item.imageId);
  if (!image) return;
  setActiveCanvas(item.canvasId, { keepTarget: false });
  selectSingleImage(image.id);
  const viewport = getActiveViewport();
  const rect = canvasViewport.getBoundingClientRect();
  viewport.x = rect.width / 2 - (image.x + image.width / 2) * viewport.scale;
  viewport.y = rect.height / 2 - (image.y + image.height / 2) * viewport.scale;
  saveActiveViewport();
  renderAll();
}

function setHistoryFilter(filter) {
  historyFilter = filter;
  expandedInsightGroups = new Set();
  refreshPromptInsights();
  renderHistory();
  renderInsights();
}

function setActiveCanvas(canvasId, options = {}) {
  activeCanvasId = canvasId;
  localStorage.setItem("activeCanvasId", canvasId);
  if (!options.keepTarget) selectedTarget = null;
  clearImageSelection();
  expandedInsightGroups = new Set();
  placeholder = null;
  aiInsights = null;
  clearStatus();
  refreshPromptInsights();
  renderAll();
}

function screenToWorld(clientX, clientY) {
  const rect = canvasViewport.getBoundingClientRect();
  return screenPointToWorld(clientX - rect.left, clientY - rect.top);
}

function screenPointToWorld(x, y) {
  const viewport = getActiveViewport();
  return {
    x: (x - viewport.x) / viewport.scale,
    y: (y - viewport.y) / viewport.scale
  };
}

function getActiveCanvas() {
  return appState.canvases.find(canvas => canvas.id === activeCanvasId) || appState.canvases[0];
}

function getActiveViewport() {
  const canvas = getActiveCanvas();
  if (!canvas.viewport) canvas.viewport = { x: 0, y: 0, scale: 1 };
  return canvas.viewport;
}

async function saveActiveViewport() {
  const canvas = getActiveCanvas();
  if (!canvas) return;
  try {
    const data = await apiJson(`/api/canvases/${encodeURIComponent(canvas.id)}`, {
      method: "PATCH",
      body: { viewport: canvas.viewport }
    });
    Object.assign(canvas, data.canvas);
  } catch (error) {
    showStatus(`保存视图失败：${error.message}`, "error");
  }
}

function queueViewportSave() {
  clearTimeout(viewportSaveTimer);
  viewportSaveTimer = setTimeout(saveActiveViewport, VIEWPORT_SAVE_DELAY);
}

function setGenerating(isGenerating) {
  generateButton.disabled = isGenerating || !selectedTarget;
  generateButton.textContent = isGenerating ? "生成中..." : "生成到画布";
  promptInput.disabled = isGenerating;
}

function showStatus(message, tone) {
  statusMessage.hidden = false;
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
}

function clearStatus() {
  statusMessage.hidden = true;
  statusMessage.textContent = "";
  delete statusMessage.dataset.tone;
}

async function apiGet(url) {
  const response = await fetch(url);
  return parseApiResponse(response);
}

async function apiJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body || {})
  });
  return parseApiResponse(response);
}

async function apiDelete(url) {
  const response = await fetch(url, { method: "DELETE" });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatError(data));
  }
  return data;
}

function formatError(data) {
  if (typeof data.detail === "string") return data.detail;
  if (data.detail && typeof data.detail === "object") {
    if (typeof data.detail.message === "string") return data.detail.message;
    if (typeof data.detail.error === "string") return data.detail.error;
    return JSON.stringify(data.detail);
  }
  if (typeof data.error === "string") return data.error;
  return "请求失败";
}

function setControlBusy(control, busy) {
  control.disabled = busy;
  control.dataset.busy = busy ? "true" : "false";
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function getImagesBounds(images) {
  const left = Math.min(...images.map(image => image.x));
  const top = Math.min(...images.map(image => image.y));
  const right = Math.max(...images.map(image => image.x + image.width));
  const bottom = Math.max(...images.map(image => image.y + image.height));
  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败，无法导出"));
    image.src = src;
  });
}

function drawExportGrid(ctx, width, height, scale) {
  const size = 40 * scale;
  ctx.strokeStyle = "rgba(93, 108, 121, 0.16)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += size) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += size) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawCaption(ctx, prompt, x, y, width, scale) {
  const height = 34 * scale;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillRect(x, y - height, width, height);
  ctx.fillStyle = "#16212a";
  ctx.font = `${13 * scale}px Segoe UI, sans-serif`;
  ctx.textBaseline = "middle";
  const text = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
  ctx.fillText(text, x + 10 * scale, y - height / 2, Math.max(40, width - 20 * scale));
}

function sanitizeFilename(value) {
  const name = value.trim().replace(/[\\/:*?"<>|]/g, "_");
  return name || "canvas";
}
