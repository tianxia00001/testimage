import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const settings = await readJson(path.join(rootDir, "workflow", "settings.json"), {});
const serverUrl = trimEnd(settings.serverUrl || "http://localhost:8787", "/");
const runDate = localDateString();
const runId = timeString();
const runDir = path.join(rootDir, settings.archiveDir || "runs", runDate);
const promptDir = path.join(runDir, "prompts");
const promptHistoryDir = path.join(promptDir, "history", runId);
const imageDir = path.join(runDir, "images");
const logDir = path.join(runDir, "logs");
const runHistoryDir = path.join(runDir, "run-history");
const logFile = path.join(logDir, "workflow.log");

const manifest = {
  runDate,
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  serverUrl,
  prompts: {},
  images: {},
  steps: [],
  errors: []
};

await mkdir(promptDir, { recursive: true });
await mkdir(promptHistoryDir, { recursive: true });
await mkdir(imageDir, { recursive: true });
await mkdir(logDir, { recursive: true });
await mkdir(runHistoryDir, { recursive: true });

try {
  await main();
} catch (error) {
  manifest.errors.push({
    name: "workflow-fatal",
    status: "failed",
    startedAt: manifest.startedAt,
    finishedAt: new Date().toISOString(),
    error: error.message
  });
  await log(`Fatal workflow error: ${error.message}`);
} finally {
  manifest.finishedAt = new Date().toISOString();
  manifest.status = manifest.errors.length === 0 ? "success" : "partial-failure";
  await writeManifest();
  const summary = {
    status: manifest.status,
    runDate,
    runId,
    runDir,
    feedbackUrl: `${serverUrl}/workflow/feedback?run=${encodeURIComponent(runDate)}`,
    errors: manifest.errors
  };
  console.log(JSON.stringify(summary));
}

async function main() {
  await log(`Workflow ${runDate} ${runId} started`);
  const basePrompt = (await readText(path.join(rootDir, "workflow", "base-prompt.md"))).trim();
  const projectGoal = (await readOptionalText(path.join(rootDir, "workflow", "project-goal.md"))).trim()
    || "生成一个在小红书上容易让人记住、有视觉锚点、扁平插画风格的橘猫 IP。";
  const latestFeedback = await readLatestFeedback();
  const promptWithFeedback = latestFeedback
    ? `${basePrompt}\n\n人工修改意见（下次生成必须参考）：\n${latestFeedback}`
    : basePrompt;

  await writePrompt("00-base.md", basePrompt);
  await writePrompt("01-with-feedback.md", promptWithFeedback);

  const optimized = await step("deepseek-optimize", async () => {
    const data = await apiJson("/api/prompts/optimize", {
      method: "POST",
      body: {
        prompt: promptWithFeedback,
        commonTerms: latestFeedback ? [latestFeedback] : []
      }
    });
    await writePrompt("02-deepseek-optimized.json", JSON.stringify(data, null, 2));
    manifest.prompts.deepseekOptimized = data.optimizedPrompt || promptWithFeedback;
    return data.optimizedPrompt || promptWithFeedback;
  }, promptWithFeedback);

  const canvasId = await getCanvasId();

  const initialSeedream = await step("seedream-initial", async () => {
    const data = await generateImage({
      canvasId,
      prompt: optimized,
      provider: "seedream",
      size: settings.seedreamSize || "1920x1920",
      x: 0,
      y: 0
    });
    await archiveImage("01-seedream-initial", data.image);
    return data;
  }, null);

  const qwenResult = initialSeedream?.image
    ? await step("qwen-evaluate", async () => {
        const data = await apiJson(`/api/images/${encodeURIComponent(initialSeedream.image.id)}/evaluate`, {
          method: "POST",
          body: {
            prompt: optimized,
            format: "workflow-json"
          }
        });
        await writePrompt("03-qwen-evaluation.json", JSON.stringify(data, null, 2));
        const improvedPrompt = data.improvedPrompt || data.workflow?.improvedPrompt || optimized;
        await writePrompt("04-qwen-improved.md", improvedPrompt);
        manifest.prompts.qwenImproved = improvedPrompt;
        return { ...data, improvedPrompt };
      }, null)
    : null;

  const improvedPrompt = qwenResult?.improvedPrompt || optimized;
  if (!qwenResult) {
    await writePrompt("03-qwen-evaluation.json", JSON.stringify({ skipped: true, reason: "Initial Seedream image failed" }, null, 2));
    await writePrompt("04-qwen-improved.md", improvedPrompt);
    manifest.prompts.qwenImproved = improvedPrompt;
  }

  await step("seedream-revised", async () => {
    const data = await generateImage({
      canvasId,
      prompt: improvedPrompt,
      provider: "seedream",
      size: settings.seedreamSize || "1920x1920",
      x: 420,
      y: 0
    });
    await archiveImage("02-seedream-revised", data.image);
    return data;
  }, null);

  await step("gpt-image-2", async () => {
    const data = await generateImage({
      canvasId,
      prompt: improvedPrompt,
      provider: "openrouter-gpt-image-2",
      size: settings.openrouterSize || settings.seedreamSize || "1920x1920",
      x: 840,
      y: 0
    });
    await archiveImage("03-gpt-image-2", data.image);
    return data;
  }, null);

  await step("deepseek-suggest-next-prompt", async () => {
    const promptRecords = await collectRecentPromptRecords();
    const visualAnchorPool = await readJson(path.join(rootDir, "workflow", "visual-anchor-pool.json"), {});
    const data = await apiJson("/api/workflow/suggest-prompt", {
      method: "POST",
      body: {
        runDate,
        projectGoal,
        basePrompt,
        latestFeedback,
        currentPrompt: improvedPrompt,
        promptRecords,
        visualAnchorPool
      }
    });
    const suggestedPrompt = data.suggestedPrompt || "";
    await writePrompt("05-deepseek-suggested-next.md", suggestedPrompt);
    await writePrompt("05-deepseek-suggested-next.json", JSON.stringify(data, null, 2));
    manifest.prompts.suggestedNextPrompt = suggestedPrompt;
    manifest.prompts.suggestedExperimentDirection = data.experimentDirection || "";
    manifest.prompts.suggestedChangedAnchors = Array.isArray(data.changedAnchors) ? data.changedAnchors : [];
    manifest.prompts.suggestedNextPromptSourceCount = data.sourceCount || promptRecords.length;
    return data;
  }, null);
}

async function step(name, fn, fallback) {
  const startedAt = new Date().toISOString();
  await log(`Start ${name}`);
  try {
    const result = await fn();
    manifest.steps.push({ name, status: "success", startedAt, finishedAt: new Date().toISOString() });
    await writeManifest();
    await log(`Success ${name}`);
    return result;
  } catch (error) {
    const entry = {
      name,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message
    };
    manifest.steps.push(entry);
    manifest.errors.push(entry);
    await writeManifest();
    await log(`Failed ${name}: ${error.message}`);
    return fallback;
  }
}

async function generateImage({ canvasId, prompt, provider, size, x, y }) {
  return apiJson("/api/generate", {
    method: "POST",
    body: {
      canvasId,
      prompt,
      provider,
      size,
      x,
      y,
      referenceImages: []
    }
  });
}

async function archiveImage(label, image) {
  if (!image?.url) return;
  const response = await fetch(`${serverUrl}${image.url}`);
  if (!response.ok) throw new Error(`Failed to download generated image ${image.url}: ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const ext = extensionFromContentType(contentType) || path.extname(new URL(image.url, serverUrl).pathname).replace(".", "") || "png";
  const filename = `${runId}-${label}.${ext}`;
  const bytes = Buffer.from(await response.arrayBuffer());
  const outputPath = path.join(imageDir, filename);
  await writeFile(outputPath, bytes);
  manifest.images[label] = {
    archivedPath: path.relative(runDir, outputPath).replace(/\\/g, "/"),
    sourceUrl: image.url,
    imageId: image.id,
    provider: image.provider,
    model: image.model,
    prompt: image.prompt
  };
  await writeManifest();
}

async function getCanvasId() {
  const state = await apiJson("/api/state");
  const existing = Array.isArray(state.canvases) ? state.canvases[0] : null;
  if (existing?.id) return existing.id;
  const created = await apiJson("/api/canvases", {
    method: "POST",
    body: { name: `自动工作流 ${runDate}` }
  });
  return created.canvas.id;
}

async function apiJson(route, options = {}) {
  const response = await fetch(`${serverUrl}${route}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? safeJsonParse(text) : {};
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail || data || text);
    const message = data?.error ? `${data.error}: ${detail}` : detail;
    throw new Error(`${route} failed with ${response.status}: ${message}`);
  }
  return data;
}

async function writePrompt(filename, content) {
  const filePath = path.join(promptDir, filename);
  const historyPath = path.join(promptHistoryDir, filename);
  await writeFile(filePath, content || "", "utf8");
  await writeFile(historyPath, content || "", "utf8");
  manifest.prompts[filename] = path.relative(runDir, filePath).replace(/\\/g, "/");
  manifest.prompts[`history/${filename}`] = path.relative(runDir, historyPath).replace(/\\/g, "/");
  await writeManifest();
}

async function readLatestFeedback() {
  const feedbackPath = path.join(rootDir, "data", "workflow-feedback.json");
  if (!existsSync(feedbackPath)) return "";
  const data = await readJson(feedbackPath, {});
  return typeof data.feedback === "string" ? data.feedback.trim() : "";
}

async function collectRecentPromptRecords() {
  const records = [];
  const filenames = [
    "00-base.md",
    "01-with-feedback.md",
    "02-deepseek-optimized.json",
    "03-qwen-evaluation.json",
    "04-qwen-improved.md"
  ];

  for (const date of recentLocalDates(3)) {
    const datePromptDir = path.join(rootDir, settings.archiveDir || "runs", date, "prompts");
    const promptDirs = [datePromptDir, ...(await listPromptHistoryDirs(datePromptDir))];
    for (const promptSourceDir of promptDirs) {
      const sourceName = path.relative(datePromptDir, promptSourceDir).replace(/\\/g, "/") || "latest";
      for (const filename of filenames) {
        const raw = await readOptionalText(path.join(promptSourceDir, filename));
        const content = normalizePromptRecordContent(filename, raw);
        if (content) records.push({
          date,
          name: `${sourceName}/${filename}`,
          content: truncateText(content, 2200)
        });
      }
    }
  }

  return dedupePromptRecords(records).slice(0, 24);
}

async function listPromptHistoryDirs(datePromptDir) {
  const historyRoot = path.join(datePromptDir, "history");
  try {
    const entries = await readdir(historyRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(historyRoot, entry.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function normalizePromptRecordContent(filename, raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";

  if (filename.endsWith(".json")) {
    const parsed = safeJsonParse(text);
    if (!parsed) return text;
    if (filename === "02-deepseek-optimized.json") {
      return [
        parsed.optimizedPrompt ? `DeepSeek 优化提示词：${parsed.optimizedPrompt}` : "",
        Array.isArray(parsed.changes) && parsed.changes.length ? `优化变化：${parsed.changes.join("；")}` : ""
      ].filter(Boolean).join("\n");
    }
    if (filename === "03-qwen-evaluation.json") {
      const workflow = parsed.workflow || {};
      return [
        workflow.overall ? `Qwen 总体判断：${workflow.overall}` : "",
        Array.isArray(workflow.issues) && workflow.issues.length ? `Qwen 问题：${workflow.issues.join("；")}` : "",
        Array.isArray(workflow.suggestions) && workflow.suggestions.length ? `Qwen 修改建议：${workflow.suggestions.join("；")}` : "",
        parsed.improvedPrompt || workflow.improvedPrompt ? `Qwen 改进提示词：${parsed.improvedPrompt || workflow.improvedPrompt}` : ""
      ].filter(Boolean).join("\n");
    }
  }

  return text;
}

function dedupePromptRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = record.content;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function writeManifest() {
  const text = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(runDir, "run.json"), text, "utf8");
  await writeFile(path.join(runHistoryDir, `${runId}.json`), text, "utf8");
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await writeFile(logFile, line, { flag: "a", encoding: "utf8" });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extensionFromContentType(contentType) {
  if (/png/i.test(contentType)) return "png";
  if (/jpe?g/i.test(contentType)) return "jpg";
  if (/webp/i.test(contentType)) return "webp";
  return "";
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentLocalDates(count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - index);
    return localDateString(date);
  });
}

function timeString(date = new Date()) {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${hour}${minute}${second}`;
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function trimEnd(value, char) {
  let result = value;
  while (result.endsWith(char)) result = result.slice(0, -1);
  return result;
}
