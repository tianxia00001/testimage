import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const generatedDir = path.join(__dirname, "generated");
const dataDir = path.join(__dirname, "data");
const stateFile = path.join(dataDir, "canvases.json");
const failureLogFile = path.join(dataDir, "generation-failures.jsonl");

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

    if (req.method === "POST" && url.pathname === "/api/generate") {
      return handleGenerateWithProvider(req, res);
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
          content: "You are a strict image generation reviewer. Focus on important actionable revision suggestions. Answer in Chinese."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
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

  sendJson(res, 200, {
    imageId,
    prompt,
    evaluation: evaluation.trim(),
    model: config.qwenEvaluationModel
  });
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
  const generationPrompt = `Generate an image from this prompt. Return the generated image in the assistant message images field.\n\n${prompt}`;
  const content = referenceImages.length > 0
    ? [
        { type: "text", text: generationPrompt },
        ...referenceImages.map(url => ({ type: "image_url", image_url: { url } }))
      ]
    : generationPrompt;
  const payload = {
    model,
    modalities: ["image", "text"],
    stream: false,
    messages: [{ role: "user", content }]
  };

  const apiResponse = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:8787",
      "X-Title": "Image Canvas"
    },
    body: JSON.stringify(payload)
  });
  const parsed = parseJsonResponseText(await apiResponse.text());
  if (!apiResponse.ok) {
    throw Object.assign(new Error("OpenRouter image generation failed"), {
      status: apiResponse.status,
      detail: {
        response: normalizeApiError(parsed),
        requestId: apiResponse.headers.get("x-request-id") || apiResponse.headers.get("cf-ray") || null
      }
    });
  }
  const imageResult = extractOpenRouterImage(parsed);
  if (!imageResult) {
    throw Object.assign(new Error("No image found in OpenRouter API response"), { detail: parsed });
  }
  return imageResult;
}

function openRouterImageConfig(size) {
  if (!/^\d+x\d+$/i.test(size)) return null;
  const [width, height] = size.toLowerCase().split("x").map(value => Number(value));
  if (!width || !height) return null;
  if (width === height) return { aspect_ratio: "1:1" };
  if (width > height) return { aspect_ratio: "16:9" };
  return { aspect_ratio: "9:16" };
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
      deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : null
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
    .filter(item => item.prompt && (scope !== "current" || item.canvasId === canvasId))
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 25 * 1024 * 1024) {
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
