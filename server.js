import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const generatedDir = path.join(__dirname, "generated");
const dataDir = path.join(__dirname, "data");
const runsDir = path.join(__dirname, "runs");
const stateFile = path.join(dataDir, "canvases.json");
const failureLogFile = path.join(dataDir, "generation-failures.jsonl");
const workflowFeedbackFile = path.join(dataDir, "workflow-feedback.json");

loadEnv(path.join(__dirname, ".env"));

const config = {
  apiKey: process.env.VOLCENGINE_API_KEY,
  baseUrl: trimEnd(process.env.VOLCENGINE_IMAGE_BASE_URL || "https://ark.cn-beijing.volces.com", "/"),
  path: process.env.VOLCENGINE_IMAGE_PATH || "/api/v3/images/generations",
  model: process.env.VOLCENGINE_IMAGE_MODEL || "doubao-seedream-4-5-251128",
  size: process.env.VOLCENGINE_IMAGE_SIZE || "1920x1920",
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: trimEnd(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", "/"),
  openrouterImageModel: process.env.OPENROUTER_IMAGE_MODEL || "openai/gpt-5.4-image-2",
  openrouterFallbackImageModel: process.env.OPENROUTER_FALLBACK_IMAGE_MODEL || "google/gemini-3.1-flash-image-preview",
  openrouterImageSize: normalizeOpenRouterImageSize(process.env.OPENROUTER_IMAGE_SIZE || "1K"),
  openrouterMaxTokens: Math.max(1, Math.floor(Number(process.env.OPENROUTER_MAX_TOKENS || 1024))),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekBaseUrl: trimEnd(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", "/"),
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  qwenApiKey: process.env.QWEN_API_KEY,
  qwenBaseUrl: trimEnd(process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", "/"),
  qwenEvaluationModel: process.env.QWEN_EVALUATION_MODEL || "qwen3-vl-plus"
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const state = await loadState();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, publicConfig());
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, { ...cloneState(), config: publicConfig() });
    }

    if (req.method === "GET" && url.pathname === "/api/prompt-insights") {
      return handlePromptInsights(url, res);
    }

    if (req.method === "POST" && url.pathname === "/api/prompt-insights/refine") {
      return handlePromptInsightsRefine(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/prompts/optimize") {
      return handlePromptOptimize(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/canvases") {
      return handleCreateCanvas(req, res);
    }

    const canvasMatch = url.pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (req.method === "PATCH" && canvasMatch) {
      return handleUpdateCanvas(canvasMatch[1], req, res);
    }

    const imageEvaluateMatch = url.pathname.match(/^\/api\/images\/([^/]+)\/evaluate$/);
    if (req.method === "POST" && imageEvaluateMatch) {
      return handleImageEvaluate(imageEvaluateMatch[1], req, res);
    }

    const imageMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
    if (req.method === "PATCH" && imageMatch) {
      return handleUpdateImage(imageMatch[1], req, res);
    }
    if (req.method === "DELETE" && imageMatch) {
      return handleDeleteImage(imageMatch[1], res);
    }

    const historyMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
    if (req.method === "DELETE" && historyMatch) {
      return handleDeleteHistory(historyMatch[1], res);
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      return handleGenerateWithProvider(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/images/import") {
      return handleImportImages(req, res);
    }

    if (req.method === "GET" && url.pathname === "/workflow/feedback") {
      return handleWorkflowFeedbackPage(url, res);
    }

    if (req.method === "POST" && url.pathname === "/api/workflow/feedback") {
      return handleWorkflowFeedbackSave(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/workflow/suggest-prompt") {
      return handleWorkflowSuggestPrompt(req, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/workflow/runs/")) {
      return serveWorkflowRunFile(url.pathname, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/generated/")) {
      return serveGenerated(url.pathname, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname === "/" ? "/index.html" : url.pathname, res);
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error", detail: error.message });
  }
});

server.listen(8787, () => {
  console.log("Image canvas running on localhost:8787");
});

function handlePromptInsights(url, res) {
  const scope = url.searchParams.get("scope") === "current" ? "current" : "all";
  const canvasId = url.searchParams.get("canvasId") || "";
  const prompts = selectInsightPrompts(scope, canvasId);
  sendJson(res, 200, buildPromptInsights(prompts, { scope, canvasId }));
}

async function handlePromptInsightsRefine(req, res) {
  if (!config.deepseekApiKey) {
    return sendJson(res, 500, { error: "DEEPSEEK_API_KEY is not configured" });
  }

  const body = await readJsonBody(req);
  const scope = body.scope === "current" ? "current" : "all";
  const canvasId = typeof body.canvasId === "string" ? body.canvasId : "";
  const fallbackPrompts = selectInsightPrompts(scope, canvasId);
  const prompts = Array.isArray(body.prompts)
    ? body.prompts.filter(item => typeof item === "string" && item.trim()).slice(0, 120)
    : fallbackPrompts;
  const groups = Array.isArray(body.groups) ? body.groups : buildPromptInsights(prompts, { scope, canvasId }).groups;

  if (prompts.length === 0) {
    return sendJson(res, 400, { error: "没有可分析的历史提示词" });
  }

  const apiResponse = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是图片生成提示词整理助手。",
            "请从历史提示词中提炼可复用共性，输出严格 JSON。",
            "JSON 字段：groups, recommendedTemplate, styleSummary。",
            "groups 是数组，每项包含 key,label,items；items 每项包含 text,count。",
            "分组 key 只使用 style, subject, feature, background, quality, other。",
            "不要编造历史中完全没有依据的具体主体。"
          ].join("")
        },
        {
          role: "user",
          content: JSON.stringify({
            prompts,
            localGroups: groups
          })
        }
      ]
    })
  });

  const responseText = await apiResponse.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { raw: responseText };
  }

  if (!apiResponse.ok) {
    return sendJson(res, apiResponse.status, {
      error: "DeepSeek prompt refine failed",
      detail: normalizeApiError(parsed)
    });
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return sendJson(res, 502, { error: "DeepSeek response did not include content", detail: parsed });
  }

  let refined;
  try {
    refined = JSON.parse(content);
  } catch {
    refined = parseJsonFromText(content);
  }

  if (!refined) {
    return sendJson(res, 502, { error: "DeepSeek response was not valid JSON", detail: content });
  }

  sendJson(res, 200, normalizeRefinedInsights(refined));
}

async function handlePromptOptimize(req, res) {
  if (!config.deepseekApiKey) {
    return sendJson(res, 500, { error: "DEEPSEEK_API_KEY is not configured" });
  }

  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const commonTerms = Array.isArray(body.commonTerms)
    ? body.commonTerms.filter(item => typeof item === "string" && item.trim()).slice(0, 30)
    : [];
  if (!prompt) return sendJson(res, 400, { error: "Prompt is required" });

  const apiResponse = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You optimize prompts for image generation.",
            "Return strict JSON with optimizedPrompt, changes, optionalNegativePrompt.",
            "Keep the user's core subject and intent. Add concrete visual details only when useful.",
            "Do not include markdown."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            reusableTerms: commonTerms,
            targetLanguage: "Chinese",
            outputRequirements: [
              "optimizedPrompt should be one ready-to-use image generation prompt",
              "changes should be a short array of important improvements",
              "optionalNegativePrompt can include things to avoid"
            ]
          })
        }
      ]
    })
  });

  const responseText = await apiResponse.text();
  const parsed = parseJsonResponseText(responseText);
  if (!apiResponse.ok) {
    return sendJson(res, apiResponse.status, {
      error: "DeepSeek prompt optimize failed",
      detail: normalizeApiError(parsed)
    });
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const optimized = typeof content === "string" ? parseJsonFromText(content) || safeJsonParse(content) : null;
  if (!optimized) return sendJson(res, 502, { error: "DeepSeek response was not valid JSON", detail: content || parsed });

  sendJson(res, 200, {
    optimizedPrompt: typeof optimized.optimizedPrompt === "string" ? optimized.optimizedPrompt.trim() : prompt,
    changes: Array.isArray(optimized.changes) ? optimized.changes.filter(item => typeof item === "string").slice(0, 8) : [],
    optionalNegativePrompt: typeof optimized.optionalNegativePrompt === "string" ? optimized.optionalNegativePrompt.trim() : ""
  });
}

async function handleImageEvaluate(imageId, req, res) {
  if (!config.qwenApiKey) {
    return sendJson(res, 500, { error: "QWEN_API_KEY is not configured" });
  }

  const image = state.images.find(item => item.id === imageId);
  if (!image) return sendJson(res, 404, { error: "Image not found" });

  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : image.prompt;
  const imageDataUrl = await imageUrlToDataUrl(image.url);
  const workflowJson = body.format === "workflow-json";

  const apiResponse = await fetch(`${config.qwenBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.qwenApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.qwenEvaluationModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: workflowJson
            ? [
                "You are a strict image generation reviewer.",
                "Focus on important actionable revision suggestions.",
                "Answer in strict JSON only, with keys: overall, issues, suggestions, improvedPrompt.",
                "issues and suggestions must be arrays of short Chinese strings.",
                "improvedPrompt must be one ready-to-use Chinese image generation prompt."
              ].join(" ")
            : "You are a strict image generation reviewer. Focus on important actionable revision suggestions. Answer in Chinese."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: workflowJson
                ? [
                    "请评价这张生成图是否符合提示词，并输出严格 JSON。",
                    "不要泛泛表扬，优先指出最值得改的 3-6 点。",
                    "JSON 字段：overall, issues, suggestions, improvedPrompt。",
                    "improvedPrompt 要保留原始主体和风格，并吸收你认为最重要的修改建议。",
                    `原始提示词：${prompt}`
                  ].join("\n")
                : [
                    "请评价这张生成图是否符合提示词，并重点给出重要修改建议。",
                    "不要泛泛表扬，优先指出最值得改的 3-6 点。",
                    "输出格式：总体判断、主要问题、修改建议、可直接使用的改进提示词。",
                    `原始提示词：${prompt}`
                  ].join("\n")
            },
            {
              type: "image_url",
              image_url: { url: imageDataUrl }
            }
          ]
        }
      ]
    })
  });

  const responseText = await apiResponse.text();
  const parsed = parseJsonResponseText(responseText);
  if (!apiResponse.ok) {
    return sendJson(res, apiResponse.status, {
      error: "Qwen image evaluation failed",
      detail: normalizeApiError(parsed)
    });
  }

  const evaluation = parsed?.choices?.[0]?.message?.content;
  if (typeof evaluation !== "string") {
    return sendJson(res, 502, { error: "Qwen response did not include content", detail: parsed });
  }

  const structured = workflowJson ? normalizeWorkflowEvaluation(evaluation, prompt) : null;
  sendJson(res, 200, {
    imageId,
    prompt,
    evaluation: evaluation.trim(),
    model: config.qwenEvaluationModel,
    ...(structured ? { workflow: structured, improvedPrompt: structured.improvedPrompt } : {})
  });
}

function normalizeWorkflowEvaluation(content, fallbackPrompt) {
  const parsed = parseJsonFromText(content) || safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return {
      overall: "",
      issues: [],
      suggestions: [],
      improvedPrompt: fallbackPrompt
    };
  }
  return {
    overall: typeof parsed.overall === "string" ? parsed.overall.trim() : "",
    issues: Array.isArray(parsed.issues) ? parsed.issues.filter(item => typeof item === "string").slice(0, 8) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(item => typeof item === "string").slice(0, 8) : [],
    improvedPrompt: typeof parsed.improvedPrompt === "string" && parsed.improvedPrompt.trim()
      ? parsed.improvedPrompt.trim()
      : fallbackPrompt
  };
}

async function handleCreateCanvas(req, res) {
  const body = await readJsonBody(req);
  const now = new Date().toISOString();
  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim()
    : `画布 ${state.canvases.length + 1}`;
  const canvas = {
    id: createId("canvas"),
    name,
    createdAt: now,
    updatedAt: now,
    viewport: { x: 0, y: 0, scale: 1 }
  };
  state.canvases.push(canvas);
  await saveState();
  sendJson(res, 201, { canvas });
}

async function handleUpdateCanvas(canvasId, req, res) {
  const canvas = state.canvases.find(item => item.id === canvasId);
  if (!canvas) return sendJson(res, 404, { error: "Canvas not found" });

  const body = await readJsonBody(req);
  if (typeof body.name === "string" && body.name.trim()) {
    canvas.name = body.name.trim();
  }
  if (body.viewport && typeof body.viewport === "object") {
    canvas.viewport = normalizeViewport(body.viewport, canvas.viewport);
  }
  canvas.updatedAt = new Date().toISOString();
  await saveState();
  sendJson(res, 200, { canvas });
}

async function handleUpdateImage(imageId, req, res) {
  const image = state.images.find(item => item.id === imageId);
  if (!image) return sendJson(res, 404, { error: "Image not found" });

  const body = await readJsonBody(req);
  const next = normalizeImagePatch(body, image);
  Object.assign(image, next, { updatedAt: new Date().toISOString() });
  await saveState();
  sendJson(res, 200, { image });
}

async function handleDeleteImage(imageId, res) {
  const index = state.images.findIndex(item => item.id === imageId);
  if (index === -1) return sendJson(res, 404, { error: "Image not found" });

  const [image] = state.images.splice(index, 1);
  const now = new Date().toISOString();
  for (const item of state.history) {
    if (item.imageId === imageId) {
      item.deletedAt = now;
    }
  }
  await saveState();
  sendJson(res, 200, { imageId: image.id });
}

async function handleDeleteHistory(historyId, res) {
  const history = state.history.find(item => item.id === historyId);
  if (!history) return sendJson(res, 404, { error: "History item not found" });

  history.historyDeletedAt = new Date().toISOString();
  await saveState();
  sendJson(res, 200, { historyId: history.id });
}

async function handleWorkflowFeedbackPage(url, res) {
  const run = sanitizeRunDate(url.searchParams.get("run")) || localDateString();
  const runDir = path.join(runsDir, run);
  const manifest = await readOptionalJson(path.join(runDir, "run.json")) || {};
  const feedback = await readOptionalText(path.join(runDir, "manual-feedback.md")) || "";
  const imageFiles = await listWorkflowImages(runDir);
  const promptSummary = await readOptionalText(path.join(runDir, "prompts", "04-qwen-improved.md"))
    || await readOptionalText(path.join(runDir, "prompts", "02-deepseek-optimized.json"))
    || "";
  const suggestedPrompt = await readOptionalText(path.join(runDir, "prompts", "05-deepseek-suggested-next.md")) || "";
  const status = manifest.status || "unknown";
  const imageMarkup = imageFiles.map(file => {
    const src = `/workflow/runs/${encodeURIComponent(run)}/images/${encodeURIComponent(file)}`;
    return `<figure><img src="${src}" alt="${escapeHtml(file)}"><figcaption>${escapeHtml(file)}</figcaption></figure>`;
  }).join("");
  const errorMarkup = formatWorkflowErrors(manifest.errors);
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>工作流反馈 ${escapeHtml(run)}</title>
    <style>
      body { margin: 0; font-family: "Microsoft YaHei", Arial, sans-serif; background: #f5f7fb; color: #1f2937; }
      main { max-width: 1080px; margin: 0 auto; padding: 28px; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      .meta { color: #64748b; margin-bottom: 20px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 18px 0; }
      figure { margin: 0; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
      img { display: block; width: 100%; height: auto; }
      figcaption { padding: 10px; font-size: 13px; color: #64748b; word-break: break-all; }
      textarea { box-sizing: border-box; width: 100%; min-height: 150px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
      button { margin-top: 10px; padding: 10px 16px; border: 0; border-radius: 8px; background: #2563eb; color: white; cursor: pointer; }
      button.secondary { background: #0f766e; }
      pre { white-space: pre-wrap; background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; max-height: 280px; overflow: auto; }
      .suggestion-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      .saved { color: #047857; margin-left: 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>每日工作流反馈</h1>
      <div class="meta">日期：${escapeHtml(run)} · 状态：${escapeHtml(status)} · 归档：runs/${escapeHtml(run)}</div>
      ${errorMarkup}
      <h2>生成图片</h2>
      <div class="grid">${imageMarkup || "<p>暂无归档图片。</p>"}</div>
      <h2>最终提示词摘要</h2>
      <pre>${escapeHtml(promptSummary || "暂无提示词摘要。")}</pre>
      <h2>建议尝试提示词</h2>
      <pre id="suggestedPrompt">${escapeHtml(suggestedPrompt || "暂无建议尝试提示词。")}</pre>
      <div class="suggestion-actions">
        <button id="useSuggestedButton" class="secondary" type="button"${suggestedPrompt ? "" : " disabled"}>使用建议</button>
        <span id="useSuggestedStatus" class="saved"></span>
      </div>
      <h2>人工修改意见</h2>
      <textarea id="feedback" placeholder="写下你希望下次自动生成时采用的修改意见。">${escapeHtml(feedback)}</textarea>
      <div><button id="saveButton" type="button">保存意见</button><span id="saveStatus" class="saved"></span></div>
    </main>
    <script>
      const suggestedPrompt = ${JSON.stringify(suggestedPrompt)};
      document.querySelector("#useSuggestedButton").addEventListener("click", () => {
        if (!suggestedPrompt) return;
        document.querySelector("#feedback").value = suggestedPrompt;
        document.querySelector("#useSuggestedStatus").textContent = "已填入，可修改后保存";
      });
      document.querySelector("#saveButton").addEventListener("click", async () => {
        const response = await fetch("/api/workflow/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run: ${JSON.stringify(run)}, feedback: document.querySelector("#feedback").value })
        });
        const data = await response.json().catch(() => ({}));
        document.querySelector("#saveStatus").textContent = response.ok ? "已保存" : (data.error || "保存失败");
      });
    </script>
  </body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

async function handleWorkflowFeedbackSave(req, res) {
  const body = await readJsonBody(req);
  const run = sanitizeRunDate(body.run) || localDateString();
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  const runDir = path.join(runsDir, run);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "manual-feedback.md"), feedback, "utf8");
  if (feedback) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(workflowFeedbackFile, JSON.stringify({
      run,
      feedback,
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  }
  sendJson(res, 200, { ok: true, run, hasFeedback: Boolean(feedback) });
}

function formatWorkflowErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  const lines = errors
    .map(error => `${error.name || "unknown"}：${error.error || "执行失败"}`)
    .join("\n");
  return `<h2>失败步骤</h2><pre>${escapeHtml(lines)}</pre>`;
}

async function handleWorkflowSuggestPrompt(req, res) {
  if (!config.deepseekApiKey) {
    return sendJson(res, 500, { error: "DEEPSEEK_API_KEY is not configured" });
  }

  const body = await readJsonBody(req);
  const projectGoal = typeof body.projectGoal === "string" && body.projectGoal.trim()
    ? body.projectGoal.trim()
    : "生成一个在小红书上容易让人记住、有视觉锚点、扁平插画风格的橘猫 IP。";
  const basePrompt = typeof body.basePrompt === "string" ? body.basePrompt.trim() : "";
  const latestFeedback = typeof body.latestFeedback === "string" ? body.latestFeedback.trim() : "";
  const currentPrompt = typeof body.currentPrompt === "string" ? body.currentPrompt.trim() : "";
  const promptRecords = Array.isArray(body.promptRecords)
    ? body.promptRecords
        .map(record => ({
          date: typeof record?.date === "string" ? record.date : "",
          name: typeof record?.name === "string" ? record.name : "",
          content: typeof record?.content === "string" ? record.content.trim() : ""
        }))
        .filter(record => record.content)
        .slice(0, 40)
    : [];

  const apiResponse = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是小红书 IP 形象提示词策略师。",
            "请基于历史提示词和评价建议，输出严格 JSON。",
            "JSON 字段：suggestedPrompt, rationale。",
            "suggestedPrompt 必须是一条可直接用于图片生成的中文提示词。",
            "suggestedPrompt 必须是下一轮实验提示词，不能原样复制 currentPrompt 或历史提示词。",
            "优先强化可记忆视觉锚点、扁平插画风格、橘猫 IP 一致性。",
            "如果当前提示词已经较好，也必须提出 1-2 个明确可测试变化，例如构图、表情、视觉锚点取舍或约束简化。",
            "不要输出 markdown。"
          ].join("")
        },
        {
          role: "user",
          content: JSON.stringify({
            projectGoal,
            basePrompt,
            latestFeedback,
            currentPrompt,
            recentPromptRecords: promptRecords,
            outputRequirements: [
              "只给 1 条建议尝试提示词",
              "不要复制 currentPrompt，也不要复制 recentPromptRecords 中已有的完整提示词",
              "必须明确下一轮实验重点，且和 currentPrompt 有可见差异",
              "保留橘猫主体和扁平插画方向",
              "加入清晰、可复现、容易记住的视觉锚点",
              "适合小红书头像、贴纸或封面图传播",
              "避免过多互相冲突的元素"
            ]
          })
        }
      ]
    })
  });

  const responseText = await apiResponse.text();
  const parsed = parseJsonResponseText(responseText);
  if (!apiResponse.ok) {
    return sendJson(res, apiResponse.status, {
      error: "DeepSeek workflow prompt suggestion failed",
      detail: normalizeApiError(parsed)
    });
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const suggested = typeof content === "string" ? parseJsonFromText(content) || safeJsonParse(content) : null;
  if (!suggested) {
    return sendJson(res, 502, { error: "DeepSeek suggestion response was not valid JSON", detail: content || parsed });
  }

  let suggestedPrompt = typeof suggested.suggestedPrompt === "string" && suggested.suggestedPrompt.trim()
    ? suggested.suggestedPrompt.trim()
    : currentPrompt || basePrompt;
  let rationale = typeof suggested.rationale === "string" ? suggested.rationale.trim() : "";
  const existingPrompts = [
    basePrompt,
    currentPrompt,
    ...promptRecords.map(record => record.content)
  ].filter(Boolean);
  if (isDuplicatePrompt(suggestedPrompt, existingPrompts)) {
    suggestedPrompt = buildNextExperimentPrompt({ currentPrompt, basePrompt, latestFeedback });
    rationale = rationale
      ? `${rationale}\nDeepSeek 返回内容与现有提示词重复，已自动改写为下一轮实验提示词。`
      : "DeepSeek 返回内容与现有提示词重复，已自动改写为下一轮实验提示词。";
  }
  sendJson(res, 200, {
    suggestedPrompt,
    rationale,
    sourceCount: promptRecords.length,
    model: config.deepseekModel
  });
}

function isDuplicatePrompt(candidate, prompts) {
  const normalizedCandidate = normalizePromptForCompare(candidate);
  if (!normalizedCandidate) return true;
  return prompts.some(prompt => normalizePromptForCompare(prompt) === normalizedCandidate);
}

function normalizePromptForCompare(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、,.，;:]/g, "")
    .trim();
}

function buildNextExperimentPrompt({ currentPrompt, basePrompt, latestFeedback }) {
  const foundation = currentPrompt || basePrompt || "扁平矢量插画风格，一只原创橘猫 IP，纯白背景。";
  const feedback = latestFeedback ? `同时吸收人工反馈：${latestFeedback}。` : "";
  return [
    "原创橘猫 IP 形象，扁平矢量插画风格，适合小红书头像和贴纸传播。",
    "本轮实验重点：保留 2 头身圆滚滚橘猫、橘白配色、纯白背景，但把视觉锚点收敛为“右耳趴下 + 红色小蝴蝶结 + 半眯斜视的傲娇表情”。",
    "构图改为正面居中头像式全身，头大身体短，四肢极短，腹部圆润；虎斑纹简洁清晰，线条统一黑色描边。",
    "减少过细硬性约束，不再强调精确线宽和固定胡须数量，优先保证角色可爱、容易记住、重复生成时特征稳定。",
    feedback,
    `参考上一轮方向：${foundation}`
  ].filter(Boolean).join("");
}

async function handleImportImages(req, res) {
  const body = await readJsonBody(req);
  const canvasId = typeof body.canvasId === "string" ? body.canvasId : "";
  const canvas = state.canvases.find(item => item.id === canvasId);
  if (!canvas) return sendJson(res, 400, { error: "Please select a valid canvas" });

  const imports = normalizeImportedImages(body.images);
  if (imports.length === 0) return sendJson(res, 400, { error: "No supported images were provided" });

  const now = new Date().toISOString();
  const createdImages = [];
  const createdHistory = [];
  await mkdir(generatedDir, { recursive: true });

  for (const [index, item] of imports.entries()) {
    const imageUrl = await persistImportedDataUrl(item.dataUrl);
    const naturalWidth = Math.max(1, toFiniteNumber(item.width, 280));
    const naturalHeight = Math.max(1, toFiniteNumber(item.height, 280));
    const displayWidth = clamp(toFiniteNumber(item.displayWidth, Math.min(320, naturalWidth)), 140, 420);
    const displayHeight = clamp(displayWidth * (naturalHeight / naturalWidth), 120, 520);
    const prompt = `导入：${item.name || `image-${index + 1}`}`;
    const image = {
      id: createId("image"),
      canvasId,
      url: imageUrl,
      prompt,
      model: "local-import",
      provider: "import",
      size: `${Math.round(naturalWidth)}x${Math.round(naturalHeight)}`,
      generationMode: "import",
      referenceImageCount: 0,
      x: toFiniteNumber(item.x, 0),
      y: toFiniteNumber(item.y, 0),
      width: displayWidth,
      height: displayHeight,
      createdAt: now,
      updatedAt: now
    };
    const history = {
      id: createId("history"),
      canvasId,
      imageId: image.id,
      prompt,
      model: image.model,
      provider: image.provider,
      size: image.size,
      generationMode: image.generationMode,
      referenceImageCount: 0,
      createdAt: now
    };
    state.images.push(image);
    state.history.push(history);
    createdImages.push(image);
    createdHistory.push(history);
  }

  await saveState();
  sendJson(res, 200, { images: createdImages, history: createdHistory, count: createdImages.length });
}

async function handleGenerate(req, res) {
  if (!config.apiKey) {
    return sendJson(res, 500, { error: "VOLCENGINE_API_KEY is not configured" });
  }

  const body = await readJsonBody(req);
  const canvasId = typeof body.canvasId === "string" ? body.canvasId : "";
  const canvas = state.canvases.find(item => item.id === canvasId);
  if (!canvas) return sendJson(res, 400, { error: "请选择有效画布" });

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const size = typeof body.size === "string" && body.size.trim() ? body.size.trim() : config.size;
  const referenceImages = normalizeReferenceImages(body.referenceImages);
  const x = toFiniteNumber(body.x, 0);
  const y = toFiniteNumber(body.y, 0);

  if (!prompt) return sendJson(res, 400, { error: "请输入提示词" });

  const payload = {
    model: config.model,
    prompt,
    size,
    response_format: "b64_json"
  };
  if (referenceImages.length > 0) {
    payload.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages;
  }

  const apiResponse = await fetch(`${config.baseUrl}${config.path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await apiResponse.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { raw: responseText };
  }

  if (!apiResponse.ok) {
    return sendJson(res, apiResponse.status, {
      error: "Volcengine image generation failed",
      detail: normalizeApiError(parsed)
    });
  }

  const imageResult = extractImage(parsed);
  if (!imageResult) {
    return sendJson(res, 502, {
      error: "No image found in API response",
      detail: parsed
    });
  }

  const imageUrl = await persistImageResult(imageResult);
  const now = new Date().toISOString();
  const image = {
    id: createId("image"),
    canvasId,
    url: imageUrl,
    prompt,
    model: config.model,
    size,
    generationMode: referenceImages.length > 0 ? "image-to-image" : "text-to-image",
    referenceImageCount: referenceImages.length,
    x,
    y,
    width: 360,
    height: 360,
    createdAt: now,
    updatedAt: now
  };
  const history = {
    id: createId("history"),
    canvasId,
    imageId: image.id,
    prompt,
    model: config.model,
    size,
    generationMode: image.generationMode,
    referenceImageCount: image.referenceImageCount,
    createdAt: now
  };

  state.images.push(image);
  state.history.push(history);
  await saveState();

  sendJson(res, 200, { image, history });
}

async function handleGenerateWithProvider(req, res) {
  const body = await readJsonBody(req);
  const canvasId = typeof body.canvasId === "string" ? body.canvasId : "";
  const canvas = state.canvases.find(item => item.id === canvasId);
  if (!canvas) return sendJson(res, 400, { error: "Please select a valid canvas" });

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const provider = normalizeImageProvider(body.provider);
  const size = typeof body.size === "string" && body.size.trim() ? body.size.trim() : config.size;
  const referenceImages = normalizeReferenceImages(body.referenceImages);
  const x = toFiniteNumber(body.x, 0);
  const y = toFiniteNumber(body.y, 0);

  if (!prompt) return sendJson(res, 400, { error: "Please enter a prompt" });

  const selectedModel = getImageModelConfig(provider);
  if (!selectedModel.apiKey) {
    return sendJson(res, 500, { error: `${selectedModel.envKey} is not configured` });
  }

  let imageResult;
  try {
    imageResult = provider.startsWith("openrouter-")
      ? await generateOpenRouterImage({ prompt, size, referenceImages, model: selectedModel.model })
      : await generateVolcengineImage({ prompt, size, referenceImages });
  } catch (error) {
    await logGenerationFailure({
      provider,
      model: selectedModel.model,
      status: error.status || 502,
      error: error.message || "Image generation failed",
      detail: error.detail || null,
      prompt,
      size,
      referenceImageCount: referenceImages.length
    });
    return sendJson(res, error.status || 502, {
      error: error.message || "Image generation failed",
      detail: error.detail || null,
      logFile: "data/generation-failures.jsonl"
    });
  }

  const imageUrl = await persistImageResult(imageResult);
  const now = new Date().toISOString();
  const image = {
    id: createId("image"),
    canvasId,
    url: imageUrl,
    prompt,
    model: selectedModel.model,
    provider,
    size,
    generationMode: referenceImages.length > 0 ? "image-to-image" : "text-to-image",
    referenceImageCount: referenceImages.length,
    x,
    y,
    width: 360,
    height: 360,
    createdAt: now,
    updatedAt: now
  };
  const history = {
    id: createId("history"),
    canvasId,
    imageId: image.id,
    prompt,
    model: selectedModel.model,
    provider,
    size,
    generationMode: image.generationMode,
    referenceImageCount: image.referenceImageCount,
    createdAt: now
  };

  state.images.push(image);
  state.history.push(history);
  await saveState();

  sendJson(res, 200, { image, history });
}

function getImageModelConfig(provider) {
  if (provider === "openrouter-gpt-image-2") {
    return {
      provider,
      label: "OpenRouter GPT Image 2",
      model: config.openrouterImageModel,
      apiKey: config.openrouterApiKey,
      envKey: "OPENROUTER_API_KEY"
    };
  }
  if (provider === "openrouter-gemini-image") {
    return {
      provider,
      label: "OpenRouter Gemini Image",
      model: config.openrouterFallbackImageModel,
      apiKey: config.openrouterApiKey,
      envKey: "OPENROUTER_API_KEY"
    };
  }
  return {
    provider: "seedream",
    label: "Seedream",
    model: config.model,
    apiKey: config.apiKey,
    envKey: "VOLCENGINE_API_KEY"
  };
}

function normalizeImageProvider(provider) {
  if (provider === "openrouter-gpt-image-2" || provider === "openrouter-gemini-image") return provider;
  return "seedream";
}

async function generateVolcengineImage({ prompt, size, referenceImages }) {
  const payload = {
    model: config.model,
    prompt,
    size,
    response_format: "b64_json"
  };
  if (referenceImages.length > 0) {
    payload.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages;
  }

  const apiResponse = await fetch(`${config.baseUrl}${config.path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const parsed = parseJsonResponseText(await apiResponse.text());
  if (!apiResponse.ok) {
    throw Object.assign(new Error("Volcengine image generation failed"), {
      status: apiResponse.status,
      detail: normalizeApiError(parsed)
    });
  }
  const imageResult = extractImage(parsed);
  if (!imageResult) {
    throw Object.assign(new Error("No image found in Volcengine API response"), { detail: parsed });
  }
  return imageResult;
}

async function generateOpenRouterImage({ prompt, size, referenceImages, model }) {
  const content = referenceImages.length > 0
    ? [
        { type: "text", text: prompt },
        ...referenceImages.map(url => ({ type: "image_url", image_url: { url } }))
      ]
    : prompt;
  const payload = {
    model,
    modalities: ["image", "text"],
    max_tokens: config.openrouterMaxTokens,
    stream: false,
    messages: [{ role: "user", content }]
  };
  const imageConfig = openRouterImageConfig(size);
  if (imageConfig) {
    payload.image_config = imageConfig;
  }

  const apiResult = await postOpenRouterJson(payload);
  const parsed = parseJsonResponseText(apiResult.text);
  if (!apiResult.ok) {
    throw Object.assign(new Error("OpenRouter image generation failed"), {
      status: apiResult.status,
      detail: {
        response: normalizeApiError(parsed),
        requestId: apiResult.requestId,
        transport: apiResult.transport
      }
    });
  }
  const imageResult = extractOpenRouterImage(parsed);
  if (!imageResult) {
    throw Object.assign(new Error("No image found in OpenRouter API response"), { detail: parsed });
  }
  return imageResult;
}

async function postOpenRouterJson(payload) {
  const url = `${config.openrouterBaseUrl}/chat/completions`;
  const headers = openRouterHeaders();
  try {
    return await postOpenRouterJsonWithCurl(url, headers, payload);
  } catch (curlError) {
    const fetchResult = await postOpenRouterJsonWithFetch(url, headers, payload);
    if (fetchResult.ok) return fetchResult;
    return {
      ...fetchResult,
      text: JSON.stringify({
        error: "OpenRouter curl request failed and fetch fallback also failed",
        curlError: curlError.message,
        fetchStatus: fetchResult.status,
        fetchResponse: normalizeApiError(parseJsonResponseText(fetchResult.text))
      })
    };
  }
}

async function postOpenRouterJsonWithFetch(url, headers, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const result = {
    ok: response.ok,
    status: response.status,
    text,
    requestId: response.headers.get("x-request-id") || response.headers.get("cf-ray") || null,
    transport: "fetch"
  };
  return result;
}

function openRouterHeaders() {
  return {
    "Authorization": `Bearer ${config.openrouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:8787",
    "X-Title": "Image Canvas"
  };
}

function postOpenRouterJsonWithCurl(url, headers, payload) {
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "-sS",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
    "-X",
    "POST",
    url
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push("--data-binary", "@-");

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("curl fallback timed out"));
    }, 240000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }
      const marker = "\n__HTTP_STATUS__:";
      const markerIndex = stdout.lastIndexOf(marker);
      if (markerIndex === -1) {
        reject(new Error("curl response did not include HTTP status"));
        return;
      }
      const text = stdout.slice(0, markerIndex);
      const status = Number(stdout.slice(markerIndex + marker.length).trim());
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text,
        requestId: null,
        transport: "curl"
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function openRouterImageConfig(size) {
  const normalized = typeof size === "string" ? size.trim() : "";
  if (/^(1K|2K|4K)$/i.test(normalized)) {
    return { aspect_ratio: "1:1", image_size: normalized.toUpperCase() };
  }
  if (!/^\d+x\d+$/i.test(normalized)) {
    return { aspect_ratio: "1:1", image_size: "1K" };
  }
  const [width, height] = normalized.toLowerCase().split("x").map(value => Number(value));
  if (!width || !height) return { aspect_ratio: "1:1", image_size: "1K" };
  const image_size = config.openrouterImageSize;
  if (width === height) return { aspect_ratio: "1:1", image_size };
  if (width > height) return { aspect_ratio: "16:9", image_size };
  return { aspect_ratio: "9:16", image_size };
}

function normalizeOpenRouterImageSize(size) {
  return /^(1K|2K|4K)$/i.test(String(size || "").trim())
    ? String(size).trim().toUpperCase()
    : "1K";
}

async function logGenerationFailure(entry) {
  await mkdir(dataDir, { recursive: true });
  const record = {
    createdAt: new Date().toISOString(),
    provider: entry.provider,
    model: entry.model,
    status: entry.status,
    error: entry.error,
    detail: sanitizeLogValue(entry.detail),
    promptPreview: typeof entry.prompt === "string" ? entry.prompt.slice(0, 500) : "",
    size: entry.size,
    referenceImageCount: entry.referenceImageCount
  };
  await appendFile(failureLogFile, `${JSON.stringify(record)}\n`, "utf8");
}

function sanitizeLogValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /key|token|authorization|secret|password/i.test(key)
        ? "[redacted]"
        : sanitizeLogValue(item);
    }
    return output;
  }
  return value;
}

function redactSecrets(text) {
  return text.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

async function persistImageResult(imageResult) {
  if (imageResult.kind === "url") return imageResult.data;

  await mkdir(generatedDir, { recursive: true });
  const buffer = Buffer.from(imageResult.data, "base64");
  const ext = sniffImageExtension(buffer);
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  await writeFile(path.join(generatedDir, filename), buffer);
  return `/generated/${filename}`;
}

async function persistImportedDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("Unsupported imported image data");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 10 * 1024 * 1024) throw new Error("Imported image is larger than 10MB");
  const ext = sniffImageExtension(buffer);
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  await writeFile(path.join(generatedDir, filename), buffer);
  return `/generated/${filename}`;
}

async function loadState() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(stateFile)) {
    const initial = ensureStateShape({});
    await writeState(initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(stripBom(await readFile(stateFile, "utf8")));
    const normalized = ensureStateShape(parsed);
    await writeState(normalized);
    return normalized;
  } catch (error) {
    const fallback = ensureStateShape({});
    fallback.loadError = error.message;
    await writeState(fallback);
    return fallback;
  }
}

function ensureStateShape(input) {
  const now = new Date().toISOString();
  const canvases = Array.isArray(input.canvases) ? input.canvases : [];
  const images = Array.isArray(input.images) ? input.images : [];
  const history = Array.isArray(input.history) ? input.history : [];

  const normalized = {
    version: 1,
    canvases: canvases.map((canvas, index) => ({
      id: typeof canvas.id === "string" ? canvas.id : createId("canvas"),
      name: typeof canvas.name === "string" && canvas.name.trim() ? canvas.name : `画布 ${index + 1}`,
      createdAt: typeof canvas.createdAt === "string" ? canvas.createdAt : now,
      updatedAt: typeof canvas.updatedAt === "string" ? canvas.updatedAt : now,
      viewport: normalizeViewport(canvas.viewport, { x: 0, y: 0, scale: 1 })
    })),
    images: images.map(image => ({
      id: typeof image.id === "string" ? image.id : createId("image"),
      canvasId: typeof image.canvasId === "string" ? image.canvasId : "",
      url: typeof image.url === "string" ? image.url : "",
      prompt: typeof image.prompt === "string" ? image.prompt : "",
      model: typeof image.model === "string" ? image.model : config.model,
      provider: typeof image.provider === "string" ? image.provider : "seedream",
      size: typeof image.size === "string" ? image.size : config.size,
      generationMode: typeof image.generationMode === "string" ? image.generationMode : "text-to-image",
      referenceImageCount: Math.max(0, toFiniteNumber(image.referenceImageCount, 0)),
      x: toFiniteNumber(image.x, 0),
      y: toFiniteNumber(image.y, 0),
      width: Math.max(80, toFiniteNumber(image.width, 360)),
      height: Math.max(80, toFiniteNumber(image.height, 360)),
      createdAt: typeof image.createdAt === "string" ? image.createdAt : now,
      updatedAt: typeof image.updatedAt === "string" ? image.updatedAt : now
    })).filter(image => image.canvasId && image.url),
    history: history.map(item => ({
      id: typeof item.id === "string" ? item.id : createId("history"),
      canvasId: typeof item.canvasId === "string" ? item.canvasId : "",
      imageId: typeof item.imageId === "string" ? item.imageId : "",
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      model: typeof item.model === "string" ? item.model : config.model,
      provider: typeof item.provider === "string" ? item.provider : "seedream",
      size: typeof item.size === "string" ? item.size : config.size,
      generationMode: typeof item.generationMode === "string" ? item.generationMode : "text-to-image",
      referenceImageCount: Math.max(0, toFiniteNumber(item.referenceImageCount, 0)),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
      deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null,
      historyDeletedAt: typeof item.historyDeletedAt === "string" ? item.historyDeletedAt : null
    })).filter(item => item.canvasId && item.prompt)
  };

  if (normalized.canvases.length === 0) {
    normalized.canvases.push({
      id: createId("canvas"),
      name: "画布 1",
      createdAt: now,
      updatedAt: now,
      viewport: { x: 0, y: 0, scale: 1 }
    });
  }

  return normalized;
}

async function saveState() {
  await writeState(state);
}

async function writeState(value) {
  await mkdir(dataDir, { recursive: true });
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmpFile, escapeJsonForStorage(JSON.stringify(value, null, 2)), "utf8");
  await rename(tmpFile, stateFile);
}

function publicConfig() {
  const imageModels = [
    {
      provider: "seedream",
      label: "Seedream 4.5",
      model: config.model,
      size: config.size,
      available: Boolean(config.apiKey)
    },
    {
      provider: "openrouter-gpt-image-2",
      label: "OpenRouter GPT Image 2",
      model: config.openrouterImageModel,
      size: "auto",
      available: Boolean(config.openrouterApiKey)
    },
    {
      provider: "openrouter-gemini-image",
      label: "OpenRouter Gemini Image",
      model: config.openrouterFallbackImageModel,
      size: "auto",
      available: Boolean(config.openrouterApiKey)
    }
  ];
  return {
    imageModel: config.model,
    imageSize: config.size,
    defaultImageProvider: "seedream",
    imageModels,
    hasVolcengineKey: Boolean(config.apiKey),
    hasOpenrouterKey: Boolean(config.openrouterApiKey),
    hasDeepseekKey: Boolean(config.deepseekApiKey),
    hasQwenKey: Boolean(config.qwenApiKey),
    qwenEvaluationModel: config.qwenEvaluationModel,
    supportsReferenceImages: true
  };
}

function cloneState() {
  return JSON.parse(JSON.stringify({
    version: state.version,
    canvases: state.canvases,
    images: state.images,
    history: state.history
  }));
}

function selectInsightPrompts(scope, canvasId) {
  return state.history
    .filter(item => item.prompt && !item.historyDeletedAt && (scope !== "current" || item.canvasId === canvasId))
    .map(item => item.prompt.trim())
    .filter(Boolean);
}

function buildPromptInsights(prompts, meta) {
  const buckets = createInsightBuckets();
  for (const group of Object.values(buckets)) {
    if (!Array.isArray(group.moreItems)) group.moreItems = [];
  }
  const totalPrompts = prompts.length;
  const phraseCounts = new Map();

  for (const prompt of prompts) {
    const phrases = extractPromptPhrases(prompt);
    for (const phrase of phrases) {
      const normalized = normalizePhrase(phrase);
      if (!normalized) continue;
      phraseCounts.set(normalized, (phraseCounts.get(normalized) || 0) + 1);
    }
  }

  const sorted = [...phraseCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 80);
  const moreSorted = [...phraseCounts.entries()]
    .filter(([, count]) => count === 1)
    .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 120);

  for (const [text, count] of sorted) {
    const key = categorizePhrase(text);
    buckets[key].items.push({
      text,
      count,
      lowFrequency: false
    });
  }

  for (const [text, count] of moreSorted) {
    const key = categorizePhrase(text);
    buckets[key].moreItems.push({
      text,
      count,
      lowFrequency: true
    });
  }

  const groups = Object.values(buckets).map(group => ({
    ...group,
    items: group.items.slice(0, 12),
    moreItems: group.moreItems.slice(0, 24)
  }));

  return {
    scope: meta.scope,
    canvasId: meta.canvasId,
    totalPrompts,
    groups,
    template: buildPromptTemplate(groups),
    updatedAt: new Date().toISOString()
  };
}

function createInsightBuckets() {
  return {
    style: { key: "style", label: "风格", items: [] },
    subject: { key: "subject", label: "主体", items: [] },
    feature: { key: "feature", label: "特征", items: [] },
    background: { key: "background", label: "背景", items: [] },
    quality: { key: "quality", label: "质量词", items: [] },
    other: { key: "other", label: "其他", items: [] }
  };
}

function extractPromptPhrases(prompt) {
  const segments = prompt
    .split(/[，,、。；;|\n\r]+/g)
    .map(item => item.trim())
    .filter(Boolean);
  const phrases = new Set();

  for (const segment of segments) {
    phrases.add(segment);
    if (/^[\x00-\x7F]+$/.test(segment)) {
      for (const token of segment.split(/\s+/g)) {
        if (token.length >= 3) phrases.add(token);
      }
    }
  }

  return [...phrases];
}

function normalizePhrase(phrase) {
  return phrase
    .replace(/\s+/g, " ")
    .replace(/^[的地得\s]+|[的地得\s]+$/g, "")
    .trim();
}

function categorizePhrase(text) {
  const lower = text.toLowerCase();
  if (/(风格|插画|写实|摄影|minimal|icon|图标|flat|anime|3d|水彩|油画)/i.test(lower)) return "style";
  if (/(背景|白色背景|黑色背景|场景|室内|户外|居中|构图|background)/i.test(lower)) return "background";
  if (/(高清|干净|细节|无文字|无水印|超清|高质量|精致|轮廓|柔和|quality|detail)/i.test(lower)) return "quality";
  if (/(红|橙|黄|绿|蓝|紫|粉|黑|白|灰|金|银|颜色|耳朵|眼睛|毛发|大|小|圆|长|短|特征|feature)/i.test(lower)) return "feature";
  if (/(一只|一个|一张|人物|角色|产品|动物|柴犬|狗|猫|人|女孩|男孩|主体|subject|product|person)/i.test(lower)) return "subject";
  return "other";
}

function buildPromptTemplate(groups) {
  const preferredOrder = ["style", "subject", "feature", "background", "quality"];
  const parts = [];
  for (const key of preferredOrder) {
    const group = groups.find(item => item.key === key);
    const text = group?.items?.[0]?.text;
    if (text) parts.push(text);
  }
  return parts.join("，");
}

function normalizeRefinedInsights(input) {
  const localBuckets = createInsightBuckets();
  const groups = Array.isArray(input.groups) ? input.groups : [];
  for (const group of groups) {
    const key = typeof group.key === "string" && localBuckets[group.key] ? group.key : "other";
    const items = Array.isArray(group.items) ? group.items : [];
    localBuckets[key].items = items
      .map(item => ({
        text: typeof item.text === "string" ? item.text.trim() : "",
        count: Math.max(1, toFiniteNumber(item.count, 1)),
        lowFrequency: false
      }))
      .filter(item => item.text)
      .slice(0, 12);
  }

  return {
    groups: Object.values(localBuckets),
    recommendedTemplate: typeof input.recommendedTemplate === "string" ? input.recommendedTemplate.trim() : "",
    styleSummary: typeof input.styleSummary === "string" ? input.styleSummary.trim() : ""
  };
}

function normalizeReferenceImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(item => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(item) || /^https?:\/\//i.test(item))
    .slice(0, 4);
}

function normalizeImportedImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(item => item && typeof item === "object")
    .map(item => ({
      name: typeof item.name === "string" ? item.name.trim().slice(0, 180) : "",
      dataUrl: typeof item.dataUrl === "string" ? item.dataUrl.trim() : "",
      width: toFiniteNumber(item.width, 0),
      height: toFiniteNumber(item.height, 0),
      displayWidth: toFiniteNumber(item.displayWidth, 0),
      x: toFiniteNumber(item.x, 0),
      y: toFiniteNumber(item.y, 0)
    }))
    .filter(item => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(item.dataUrl))
    .slice(0, 20);
}

function parseJsonFromText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeViewport(input, fallback) {
  return {
    x: toFiniteNumber(input?.x, fallback.x),
    y: toFiniteNumber(input?.y, fallback.y),
    scale: clamp(toFiniteNumber(input?.scale, fallback.scale), 0.12, 4)
  };
}

function normalizeImagePatch(input, fallback) {
  return {
    x: toFiniteNumber(input.x, fallback.x),
    y: toFiniteNumber(input.y, fallback.y),
    width: Math.max(80, toFiniteNumber(input.width, fallback.width)),
    height: Math.max(80, toFiniteNumber(input.height, fallback.height))
  };
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

async function serveStatic(routePath, res) {
  const relativePath = decodeURIComponent(routePath).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(publicDir, relativePath);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function serveGenerated(routePath, res) {
  const filename = path.basename(routePath);
  const filePath = path.join(generatedDir, filename);
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function serveWorkflowRunFile(routePath, res) {
  const match = routePath.match(/^\/workflow\/runs\/(\d{4}-\d{2}-\d{2})\/images\/([^/]+)$/);
  if (!match) return sendJson(res, 404, { error: "Not found" });
  const run = sanitizeRunDate(match[1]);
  const filename = path.basename(decodeURIComponent(match[2]));
  const filePath = path.resolve(runsDir, run, "images", filename);
  const allowedDir = path.resolve(runsDir, run, "images");
  if (filePath !== allowedDir && !filePath.startsWith(`${allowedDir}${path.sep}`)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 40 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function extractImage(parsed) {
  const first = Array.isArray(parsed?.data) ? parsed.data[0] : null;
  if (!first || typeof first !== "object") return null;
  if (typeof first.b64_json === "string") return { kind: "base64", data: stripDataUrl(first.b64_json) };
  if (typeof first.url === "string") return { kind: "url", data: first.url };
  if (typeof first.image === "string") {
    return first.image.startsWith("http")
      ? { kind: "url", data: first.image }
      : { kind: "base64", data: stripDataUrl(first.image) };
  }
  return null;
}

function extractOpenRouterImage(parsed) {
  const message = Array.isArray(parsed?.choices) ? parsed.choices[0]?.message : null;
  const images = Array.isArray(message?.images) ? message.images : [];
  for (const item of images) {
    const url = item?.image_url?.url || item?.url;
    if (typeof url !== "string") continue;
    return url.startsWith("http")
      ? { kind: "url", data: url }
      : { kind: "base64", data: stripDataUrl(url) };
  }
  if (typeof message?.content === "string") {
    const match = message.content.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i);
    if (match) return { kind: "base64", data: stripDataUrl(match[0]) };
  }
  return null;
}

function normalizeApiError(parsed) {
  if (typeof parsed?.error?.message === "string") return parsed.error.message;
  if (typeof parsed?.message === "string") return parsed.message;
  return parsed;
}

function parseJsonResponseText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readOptionalJson(filePath) {
  const text = await readOptionalText(filePath);
  return text ? safeJsonParse(text) : null;
}

async function listWorkflowImages(runDir) {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(runDir, "images"), { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function sanitizeRunDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function imageUrlToDataUrl(url) {
  if (/^data:image\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith("/generated/")) throw new Error("Only generated local images can be evaluated");

  const filename = path.basename(url);
  const filePath = path.join(generatedDir, filename);
  const buffer = await readFile(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function stripDataUrl(value) {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  return index === -1 ? value : value.slice(index + marker.length);
}

function sniffImageExtension(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  return "png";
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function trimEnd(value, char) {
  let result = value;
  while (result.endsWith(char)) result = result.slice(0, -1);
  return result;
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function escapeJsonForStorage(value) {
  return value.replace(/[^\x00-\x7F]/g, char => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}
