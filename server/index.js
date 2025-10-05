import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import Replicate from "replicate";
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Blob } from "buffer";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = parseInt(process.env.PORT || "5002", 10);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const MAX_IMAGE_DIMENSION = parseInt(process.env.MAX_IMAGE_DIMENSION || "2048", 10);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_REMOTE_IMPORT_SOURCE_BYTES = 80 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 256;
const ADVANCED_CARD_HINTS = {
  intent:
    "Focus on the cinematic intent, theme, or emotional beat. Provide concise story framing.",
  subject:
    "Describe identity, styling, wardrobe textures, and any hero props that ground reality.",
  action:
    "Specify the main action plus a micro-action, along with gaze direction and pose cues.",
  camera:
    "Lock the camera reality—vantage height, framing, focal length, aperture, lens type, tilt.",
  lighting:
    "Define key/fill/rim lights, color temperatures, and how light interacts with the scene.",
  environment:
    "Paint the location materials, atmosphere, weather, and background silhouettes.",
  texture:
    "Mention tactile textures, bloom/flare, grain, and overall color grading style.",
  composition:
    "State composition constraints such as headroom, leading lines, reflections, or isolation.",
  negative:
    "List precise negative tokens targeting failure modes you want to avoid.",
};

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : undefined,
    credentials: true,
  })
);
app.use(express.json({ limit: "20mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 12,
    fileSize: MAX_UPLOAD_SOURCE_BYTES,
  },
});

const ensureReplicate = () => {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not set");
  }

  return new Replicate({ auth: token });
};

const resolveInstructions = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    try {
      return raw.map((entry) => JSON.parse(entry));
    } catch (error) {
      console.warn("Unable to parse instruction payload", error);
      return [];
    }
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Unable to parse instruction payload", error);
    return [];
  }
};

const parseBoolean = (value) => {
  if (value === undefined || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => parseBoolean(entry));
  }

  const normalized = value.toString().trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(normalized);
};

const defaultModelSlug = "bytedance/seedream-4";
const defaultGrokModel = "grok-4-fast";
const defaultNanoBananaModel = "gemini-1.5-flash";
const grokApiUrl = process.env.GROK_API_BASE_URL || "https://api.x.ai/v1/chat/completions";
const FAL_SIZE_PRESETS = {
  "1K": 1024,
  "2K": 2048,
  "4K": 4096,
};
const FAL_ASPECT_RATIOS = {
  "1:1": [1, 1],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "3:2": [3, 2],
  "2:3": [2, 3],
  "21:9": [21, 9],
};

const parseModelSlug = (slug) => {
  const [owner, name] = (slug || "").split("/");
  if (!owner || !name) {
    throw new Error(`Invalid model slug: ${slug}`);
  }

  return { owner, name };
};

let cachedModelIdentifier = null;
let cachedModelSource = null;
let falConfigured = false;
let nanoBananaClient = null;

const computeFalImageSize = (sizeOption, aspectRatio, customWidth, customHeight) => {
  const clampDimension = (value) => Math.min(Math.max(Math.round(value), 1024), 4096);

  if (typeof sizeOption === "string" && sizeOption.toLowerCase() === "custom") {
    if (customWidth && customHeight) {
      return {
        width: clampDimension(customWidth),
        height: clampDimension(customHeight),
      };
    }
    return null;
  }

  const base = FAL_SIZE_PRESETS[(sizeOption || "").toUpperCase()];
  if (!base) {
    return null;
  }

  const ratio = FAL_ASPECT_RATIOS[aspectRatio];
  const minDimension = 1024;
  const maxDimension = 4096;

  if (!ratio) {
    const dimension = clampDimension(base);
    return { width: dimension, height: dimension };
  }

  const [ratioWidth, ratioHeight] = ratio;
  const minRatioComponent = Math.min(ratioWidth, ratioHeight);

  let width = Math.round((base * ratioWidth) / minRatioComponent);
  let height = Math.round((base * ratioHeight) / minRatioComponent);

  const scaleDown = Math.max(width / maxDimension, height / maxDimension, 1);
  if (scaleDown > 1) {
    width = Math.round(width / scaleDown);
    height = Math.round(height / scaleDown);
  }

  const currentMin = Math.min(width, height);
  if (currentMin < 1024) {
    const scaleUp = 1024 / currentMin;
    width = Math.round(width * scaleUp);
    height = Math.round(height * scaleUp);

    const secondScaleDown = Math.max(width / maxDimension, height / maxDimension, 1);
    if (secondScaleDown > 1) {
      width = Math.round(width / secondScaleDown);
      height = Math.round(height / secondScaleDown);
    }
  }

  return {
    width: clampDimension(width),
    height: clampDimension(height),
  };
};

const dataUriToBlob = (dataUri) => {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:")) {
    throw new Error("Invalid data URI");
  }

  const match = dataUri.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported data URI format");
  }

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  return {
    blob: new Blob([buffer], { type: mimeType || "application/octet-stream" }),
    mimeType,
  };
};

const parseDataUri = (dataUri) => {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:")) {
    throw new Error("Invalid data URI");
  }

  const match = dataUri.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported data URI format");
  }

  return {
    mimeType: match[1] || "application/octet-stream",
    base64: match[2],
  };
};

const uploadReferenceToFal = async (falClient, reference) => {
  try {
    const { blob } = dataUriToBlob(reference.dataUri);
    const url = await falClient.storage.upload(blob);
    return url;
  } catch (error) {
    console.error("fal.ai upload failed", error);
    throw new Error("Unable to upload reference image to fal.ai storage");
  }
};

const ensureFal = () => {
  const token = process.env.FAL_KEY;
  if (!token) {
    throw new Error("FAL_KEY is not set");
  }

  if (!falConfigured) {
    fal.config({ credentials: token });
    falConfigured = true;
  }

  return fal;
};

const ensureNanoBananaClient = () => {
  const apiKey =
    process.env.NANO_BANANA_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  if (!nanoBananaClient) {
    nanoBananaClient = new GoogleGenerativeAI(apiKey);
  }

  const model = process.env.NANO_BANANA_MODEL || defaultNanoBananaModel;

  return {
    client: nanoBananaClient,
    model,
  };
};

const buildNanoBananaParts = ({
  references,
  finalPrompt,
  negativePrompt,
  sizeOption,
  aspectRatio,
  customWidth,
  customHeight,
  sequentialSetting,
  maxImages,
}) => {
  const parts = [];
  const limitedReferences = references.slice(0, 4);

  limitedReferences.forEach((reference, index) => {
    try {
      const { mimeType, base64 } = parseDataUri(reference.dataUri);
      parts.push({ inlineData: { mimeType, data: base64 } });
      if (reference.prompt) {
        const label = reference.originalName || `image-${index + 1}`;
        parts.push({
          text: `Reference ${index + 1} (${label}): ${reference.prompt}`,
        });
      }
    } catch (error) {
      console.warn("Skipping reference for Nano Banana provider", error.message || error);
    }
  });

  const guidanceNotes = references
    .map((reference, index) =>
      reference.prompt
        ? `Reference ${index + 1} (${reference.originalName || `image-${index + 1}`}): ${reference.prompt}`
        : null,
    )
    .filter(Boolean);

  const promptSegments = [`PRIMARY_PROMPT:\n${finalPrompt}`];
  if (negativePrompt) {
    promptSegments.push(`NEGATIVE_PROMPT:\n${negativePrompt}`);
  }
  if (guidanceNotes.length) {
    promptSegments.push(`REFERENCE_GUIDANCE:\n${guidanceNotes.join("\n")}`);
  }

  if (typeof sizeOption === "string" && sizeOption.trim()) {
    if (sizeOption.toLowerCase() === "custom" && customWidth && customHeight) {
      promptSegments.push(`TARGET_RESOLUTION: ${customWidth}x${customHeight}`);
    } else {
      promptSegments.push(`TARGET_RESOLUTION: ${sizeOption}`);
    }
  }

  if (typeof aspectRatio === "string" && aspectRatio.trim()) {
    promptSegments.push(`TARGET_ASPECT_RATIO: ${aspectRatio}`);
  }

  if (sequentialSetting && sequentialSetting !== "disabled") {
    promptSegments.push(`SEQUENTIAL_MODE: ${sequentialSetting}`);
  }

  if (maxImages && Number.isFinite(maxImages) && maxImages > 1) {
    promptSegments.push(`REQUESTED_IMAGE_COUNT: ${maxImages}`);
  }

  parts.push({ text: promptSegments.join("\n\n") });
  return parts;
};

const extractNanoBananaOutputs = (response) => {
  const inlineImages = [];
  const textPayloads = [];

  if (!response) {
    return { inlineImages, textPayloads };
  }

  const candidates = response.candidates || [];
  candidates.forEach((candidate) => {
    const parts = candidate?.content?.parts || [];
    parts.forEach((part) => {
      if (part?.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "image/png";
        inlineImages.push(`data:${mimeType};base64,${part.inlineData.data}`);
      } else if (part?.text) {
        textPayloads.push(part.text);
      }
    });
  });

  return { inlineImages, textPayloads };
};

const normalizeOutputUrls = (output) => {
  if (!output) return [];

  if (Array.isArray(output)) {
    return output.flatMap((entry) => normalizeOutputUrls(entry));
  }

  if (typeof output === "string") {
    return [output];
  }

  if (Array.isArray(output?.images)) {
    return output.images.flatMap((image) => normalizeOutputUrls(image));
  }

  if (Array.isArray(output?.output)) {
    return output.output.flatMap((item) => normalizeOutputUrls(item));
  }

  if (output?.url) {
    return [output.url];
  }

  if (output?.image_url) {
    return [output.image_url];
  }

  if (output?.image?.url) {
    return [output.image.url];
  }

  return [];
};

const ensureGrokConfig = () => {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is not set");
  }

  const model = process.env.GROK_MODEL || process.env.GROK_API_MODEL || defaultGrokModel;
  return { apiKey, model };
};

const extractJsonBlock = (content) => {
  if (!content) {
    return "";
  }

  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  return trimmed;
};

const enhancePromptWithGrok = async ({
  basePrompt,
  negativePrompt,
  guidanceSegment,
}) => {
  const { apiKey, model } = ensureGrokConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(grokApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content:
              "You are an expert prompt engineer for generative imagery. Expand the provided base prompt into a polished production-ready prompt. Always respond in compact JSON with keys enhancedPrompt and negativePrompt.",
          },
          {
            role: "user",
            content: `BASE_PROMPT:\n${basePrompt}\n\nNEGATIVE_PROMPT:\n${negativePrompt || "(none)"}\n\nREFERENCE_GUIDANCE:\n${guidanceSegment || "none"}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Grok API error (${response.status}): ${errorText}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const jsonText = extractJsonBlock(content);

    return { content, jsonText };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Grok API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const generateAdvancedSuggestions = async ({
  cardKey,
  template,
  placeholders,
  fields,
}) => {
  const { apiKey, model } = ensureGrokConfig();

  if (!placeholders || !placeholders.length) {
    return {
      values: {},
      preview: template,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const fieldContext = Object.entries(fields || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  const hint = ADVANCED_CARD_HINTS[cardKey] || "Provide realistic, production-quality values.";

  try {
    const response = await fetch(grokApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content:
              "You are an advanced prompt engineering copilot. Given a template with ${placeholders}, propose production-ready values. Return JSON with 'values' and 'preview'. 'values' is an object where each placeholder key has 'value', 'explanation', and optional 'alternatives' (array). 'preview' is the template with placeholders replaced by the proposed values. Be concise but descriptive.",
          },
          {
            role: "user",
            content: `Card: ${cardKey}\nGuidance: ${hint}\nTemplate: ${template}\nPlaceholders: ${placeholders.join(", ")}\nExisting Context:\n${fieldContext || "(none)"}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Grok API error (${response.status}): ${errorText}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const jsonText = extractJsonBlock(content);
    if (!jsonText) {
      throw new Error("Grok response missing JSON body");
    }

    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON response from Grok");
    }

    const values = parsed.values && typeof parsed.values === "object" ? parsed.values : {};
    const preview = typeof parsed.preview === "string" ? parsed.preview : template;

    return { values, preview };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Grok API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const generateBlueprints = async ({ userPrompt = "", fields = {} }) => {
  const { apiKey, model } = ensureGrokConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const context = Object.entries(fields || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  try {
    const response = await fetch(grokApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "You are a senior cinematic prompt designer for Seedream-4. Given a user prompt, craft three complete prompt blueprints using the exact advanced formula (intent, subject, action, camera, lighting, environment, texture, composition, negative). Each blueprint must be realistic and production-ready. Respond strictly with JSON containing a 'recommended' object and an 'alternatives' array (length 2). Each blueprint object must include name, tagline, fields (with keys intent, subject, action, camera, lighting, environment, texture, composition), negative, and optional accent color (hex).",
          },
          {
            role: "user",
            content: `User prompt (seedream-4 style): ${userPrompt || "(none provided)"}\nExisting context:\n${context || "(none)"}\nTasks:\n1. Recommended blueprint should enhance the user prompt while keeping intent and identity cohesive.\n2. Provide two additional random but polished blueprints that vary camera angles, scenery, wardrobe, lighting, but still produce believable human photography.\n3. Use concise sentence fragments for each field.\n4. Ensure negatives target failure modes (plastic skin, warped anatomy, etc.).`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Grok API error (${response.status}): ${errorText}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const jsonText = extractJsonBlock(content);
    if (!jsonText) {
      throw new Error("Grok response missing JSON body");
    }

    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON response for blueprints");
    }

    const recommended = parsed.recommended;
    const alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];

    return {
      recommended,
      alternatives,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Grok API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const resolveModelIdentifier = async (replicate) => {
  const explicitModel =
    process.env.SEEDREAM4_MODEL_VERSION || process.env.SEEDREAM_MODEL_VERSION;
  const source = explicitModel || defaultModelSlug;

  if (cachedModelIdentifier && cachedModelSource === source) {
    return cachedModelIdentifier;
  }

  if (source.includes(":")) {
    cachedModelIdentifier = source;
    cachedModelSource = source;
    return cachedModelIdentifier;
  }

  const { owner, name } = parseModelSlug(source);

  try {
    const model = await replicate.models.get(owner, name);
    let versionId = model?.latest_version?.id;

    if (!versionId) {
      try {
        const versions = await replicate.models.versions.list(owner, name);
        versionId = versions?.[0]?.id;
      } catch (listError) {
        console.warn(
          "Unable to list model versions while resolving Seedream identifier",
          listError
        );
      }
    }

    if (!versionId) {
      throw new Error("Missing latest version id in Replicate response");
    }

    cachedModelIdentifier = `${owner}/${name}:${versionId}`;
    cachedModelSource = source;
    return cachedModelIdentifier;
  } catch (error) {
    console.error("Unable to resolve Seedream model version", error);
    throw new Error(
      "Seedream model version unavailable. Set SEEDREAM4_MODEL_VERSION to owner/name:version."
    );
  }
};

const coerceString = (value) => {
  if (value === undefined || value === null) {
    return "";
  }

  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.toString().trim() || "";
};

const coerceNumber = (value) => {
  const raw = coerceString(value);
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const supportedProviders = new Set(["replicate", "fal", "nano-banana"]);

const normalizeImageBuffer = async (buffer, mimeType) => {
  try {
    const metadata = await sharp(buffer, { failOnError: false }).metadata();
    const originalWidth = metadata.width || MAX_IMAGE_DIMENSION;
    const originalHeight = metadata.height || MAX_IMAGE_DIMENSION;

    const dimensionScale = Math.min(
      MAX_IMAGE_DIMENSION / originalWidth,
      MAX_IMAGE_DIMENSION / originalHeight,
      1,
    );

    let targetWidth = Math.floor(originalWidth * dimensionScale) || originalWidth;
    let targetHeight = Math.floor(originalHeight * dimensionScale) || originalHeight;

    targetWidth = Math.min(targetWidth, MAX_IMAGE_DIMENSION);
    targetHeight = Math.min(targetHeight, MAX_IMAGE_DIMENSION);

    const minimumWidth = Math.min(originalWidth, MIN_IMAGE_DIMENSION);
    const minimumHeight = Math.min(originalHeight, MIN_IMAGE_DIMENSION);

    targetWidth = Math.max(targetWidth, minimumWidth || MIN_IMAGE_DIMENSION);
    targetHeight = Math.max(targetHeight, minimumHeight || MIN_IMAGE_DIMENSION);

    let quality = 90;
    let outputBuffer = buffer;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pipeline = sharp(buffer, { failOnError: false })
        .rotate()
        .resize({
          width: targetWidth,
          height: targetHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 5 });

      outputBuffer = await pipeline.toBuffer();

      if (outputBuffer.length <= MAX_IMAGE_BYTES) {
        return { buffer: outputBuffer, contentType: "image/webp" };
      }

      if (quality > 50) {
        quality = Math.max(50, quality - 10);
      } else {
        targetWidth = Math.max(
          Math.floor(targetWidth * 0.85),
          minimumWidth || MIN_IMAGE_DIMENSION,
        );
        targetHeight = Math.max(
          Math.floor(targetHeight * 0.85),
          minimumHeight || MIN_IMAGE_DIMENSION,
        );
      }
    }

    throw new Error("Unable to compress image under 10MB");
  } catch (error) {
    console.warn("Image normalization failed", error);
    throw error;
  }
};

app.get("/", (_req, res) => {
  res.send("Seedream server is running.");
});

app.get("/demo", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Seedream Demo Runner</title>
      <style>
        body {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          padding: 24px;
          background: #0f172a;
          color: #e2e8f0;
          display: flex;
          justify-content: center;
        }
        .shell {
          width: min(720px, 100%);
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(148, 163, 184, 0.3);
          border-radius: 24px;
          padding: 24px;
          box-shadow: 0 24px 48px rgba(2, 6, 23, 0.6);
        }
        h1 {
          margin-top: 0;
        }
        label {
          display: block;
          margin-bottom: 12px;
          font-weight: 600;
        }
        textarea, select {
          width: 100%;
          border: 1px solid rgba(148, 163, 184, 0.35);
          border-radius: 12px;
          padding: 12px;
          font-size: 1rem;
          background: rgba(15, 23, 42, 0.9);
          color: inherit;
          resize: vertical;
        }
        button {
          margin-top: 16px;
          padding: 12px 20px;
          border-radius: 999px;
          border: none;
          background: linear-gradient(135deg, #38bdf8, #6366f1);
          color: white;
          font-weight: 600;
          cursor: pointer;
        }
        button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .result {
          margin-top: 24px;
          background: rgba(15, 23, 42, 0.8);
          border-radius: 16px;
          padding: 16px;
          border: 1px solid rgba(148, 163, 184, 0.25);
          overflow-x: auto;
        }
        .error {
          color: #f87171;
          font-weight: 600;
        }
        a {
          color: #38bdf8;
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <h1>Seedream Demo Runner</h1>
        <p>Send a minimal prompt to Replicate using the official slug.</p>
        <form id="demo-form">
          <label>
            Prompt
            <textarea id="prompt" rows="4">a photo of a store front called "Seedream 4", it sells books, a poster in the window says "Seedream 4 now on Replicate"</textarea>
          </label>
          <label>
            Aspect ratio
            <select id="aspect-ratio">
              <option value="match_input_image">Match input image</option>
              <option value="1:1">1:1</option>
              <option value="4:3" selected>4:3</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="3:2">3:2</option>
              <option value="2:3">2:3</option>
              <option value="21:9">21:9</option>
            </select>
          </label>
          <button id="run-button" type="submit">Run Seedream demo</button>
        </form>
        <div id="status" aria-live="polite"></div>
        <div id="result" class="result" hidden></div>
      </div>
      <script>
        const form = document.getElementById("demo-form");
        const promptField = document.getElementById("prompt");
        const aspectField = document.getElementById("aspect-ratio");
        const button = document.getElementById("run-button");
        const status = document.getElementById("status");
        const result = document.getElementById("result");

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          status.textContent = "Submitting demo run…";
          status.className = "";
          button.disabled = true;
          result.hidden = true;
          result.textContent = "";

          try {
            const response = await fetch("/api/demo-run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: promptField.value,
                aspect_ratio: aspectField.value,
              }),
            });

            const payload = await response.json();

            if (!response.ok) {
              throw new Error(payload?.error || payload?.status || "Demo run failed");
            }

            status.textContent = "Seedream responded successfully.";
            result.hidden = false;
            if (Array.isArray(payload.output)) {
              result.innerHTML = payload.output
                .map((item) =>
                  '<div><a href="' +
                  item +
                  '" target="_blank" rel="noreferrer">' +
                  item +
                  '</a></div>'
                )
                .join("");
            } else {
              result.textContent = JSON.stringify(payload, null, 2);
            }
          } catch (error) {
            status.textContent = error?.message || "Unexpected error.";
            status.className = "error";
          } finally {
            button.disabled = false;
          }
        });
      </script>
    </body>
  </html>`);
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    modelVersion:
      process.env.SEEDREAM4_MODEL_VERSION ||
      process.env.SEEDREAM_MODEL_VERSION ||
      defaultModelSlug,
  });
});

app.post("/api/import-image", async (req, res) => {
  try {
    const url = coerceString(req.body?.url);
    if (!url) {
      return res.status(400).json({ error: "Image URL is required" });
    }

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      return res
        .status(400)
        .json({ error: `Unable to fetch image (status ${response.status})` });
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) {
      return res
        .status(400)
        .json({ error: "URL does not point to an image resource" });
    }

    const arrayBuffer = await response.arrayBuffer();
    const originalBuffer = Buffer.from(arrayBuffer);
    if (originalBuffer.length > MAX_REMOTE_IMPORT_SOURCE_BYTES) {
      return res.status(413).json({ error: "Remote image is too large to process" });
    }

    let normalized;
    try {
      normalized = await normalizeImageBuffer(originalBuffer, contentType);
    } catch (error) {
      console.error("Remote image normalization failed", error);
      return res
        .status(413)
        .json({ error: "Unable to compress image under 10MB" });
    }

    const base64 = normalized.buffer.toString("base64");
    const rawName = url.split("/").pop() || "remote-image";
    const fallbackName = rawName.split("?")[0] || "remote-image";

    res.json({
      status: "ok",
      fileName: fallbackName,
      contentType: normalized.contentType,
      dataUri: `data:${normalized.contentType};base64,${base64}`,
    });
  } catch (error) {
    console.error("Import image failed", error);
    res.status(500).json({ error: "Unable to import remote image" });
  }
});

app.post("/api/enhance-prompt", async (req, res) => {
  const basePrompt = coerceString(req.body?.prompt);
  const negativePrompt = coerceString(req.body?.negativePrompt);
  const instructions = Array.isArray(req.body?.instructions)
    ? req.body.instructions
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
                originalName: coerceString(entry.originalName) || "reference",
                instruction: coerceString(entry.instruction),
              }
            : null
        )
        .filter(Boolean)
    : [];

  if (!basePrompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const guidanceSegment = instructions.length
      ? instructions
          .map(
            (entry, index) =>
              `Reference ${index + 1} (${entry.originalName}): ${entry.instruction || "no additional guidance"}`
          )
          .join("\n")
      : "none provided";

    const { content, jsonText } = await enhancePromptWithGrok({
      basePrompt,
      negativePrompt,
      guidanceSegment,
    });

    let enhancedPrompt = basePrompt;
    let enhancedNegative = negativePrompt;

    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.enhancedPrompt === "string" && parsed.enhancedPrompt.trim().length) {
            enhancedPrompt = parsed.enhancedPrompt.trim();
          }
          if (typeof parsed.negativePrompt === "string") {
            enhancedNegative = parsed.negativePrompt.trim();
          }
        }
      } catch (parseError) {
        console.warn("Unable to parse Grok enhancement JSON", jsonText, parseError);
      }
    } else {
      console.warn("Grok response did not include JSON payload", content);
    }

    res.json({
      status: "Prompt enhanced",
      prompt: enhancedPrompt,
      negativePrompt: enhancedNegative,
    });
  } catch (error) {
    console.error("Prompt enhancement failed", error);
    const message =
      error?.error?.message ||
      error?.message ||
      (typeof error === "string" ? error : null) ||
      "Unable to enhance prompt";

    res.status(500).json({ error: message });
  }
});

app.post("/api/advanced-suggestion", async (req, res) => {
  const cardKey = coerceString(req.body?.cardKey).toLowerCase();
  const template = coerceString(req.body?.template);
  const fields = req.body?.fields && typeof req.body.fields === "object" ? req.body.fields : {};

  if (!cardKey || !template) {
    return res.status(400).json({ error: "cardKey and template are required" });
  }

  const placeholderMatches = Array.from(template.matchAll(/\$\{([^}]+)\}/g));
  const placeholders = [...new Set(placeholderMatches.map((match) => match[1]))];

  try {
    const suggestions = await generateAdvancedSuggestions({
      cardKey,
      template,
      placeholders,
      fields,
    });
    res.json({
      cardKey,
      template,
      placeholders,
      ...suggestions,
    });
  } catch (error) {
    console.error("Advanced suggestion failed", error);
    res.status(500).json({ error: error?.message || "Unable to generate advanced suggestion" });
  }
});

app.post("/api/advanced-blueprints", async (req, res) => {
  const userPrompt = coerceString(req.body?.prompt);
  const fields = req.body?.fields && typeof req.body.fields === "object" ? req.body.fields : {};

  try {
    const result = await generateBlueprints({ userPrompt, fields });
    res.json(result);
  } catch (error) {
    console.error("Advanced blueprint generation failed", error);
    res.status(500).json({ error: error?.message || "Unable to generate blueprint prompts" });
  }
});

app.post("/api/demo-run", async (req, res) => {
  const prompt = coerceString(req.body?.prompt);
  const aspectRatio = coerceString(req.body?.aspect_ratio) || "match_input_image";

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const replicate = ensureReplicate();
    const replicateIdentifier = await resolveModelIdentifier(replicate);

    const output = await replicate.run(replicateIdentifier, {
      input: {
        prompt,
        aspect_ratio: aspectRatio,
      },
    });

    res.json({
      status: "Seedream demo completed",
      output,
      prompt,
      aspect_ratio: aspectRatio,
      model: replicateIdentifier,
    });
  } catch (error) {
    console.error("Seedream demo failed", error);
    res.status(500).json({
      error:
        error?.error?.message ||
        error?.message ||
        (typeof error === "string" ? error : null) ||
        "Unable to reach Replicate",
    });
  }
});

app.post("/api/generate", upload.array("images"), async (req, res) => {
  const provider = coerceString(req.body?.provider)?.toLowerCase() || "replicate";
  if (!supportedProviders.has(provider)) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }

  const prompt = (req.body?.prompt || "").toString().trim();
  const negativePrompt = (req.body?.negativePrompt || "").toString().trim();
  const instructionsRaw = req.body?.instructions;
  const disableSafetyFilter = parseBoolean(req.body?.disableSafetyFilter);
  const files = req.files || [];
  const sizeOption = coerceString(req.body?.size);
  const aspectRatio = coerceString(req.body?.aspect_ratio);
  const sequentialSetting = coerceString(req.body?.sequential_image_generation);
  const maxImages = coerceNumber(req.body?.max_images);
  const customWidth = coerceNumber(req.body?.width);
  const customHeight = coerceNumber(req.body?.height);
  const falSeed = coerceNumber(req.body?.fal_seed);
  const falSyncMode = parseBoolean(req.body?.fal_sync_mode);

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  if (provider === "replicate" && !files.length) {
    return res.status(400).json({ error: "At least one reference image is required" });
  }

  if (provider === "fal" && !files.length) {
    return res
      .status(400)
      .json({ error: "fal.ai Seedream edit requires at least one reference image" });
  }

  const instructions = resolveInstructions(instructionsRaw);

  const references = [];
  for (const file of files) {
    const fileName = file.originalname || file.fieldname;
    const [imageId, originalName] = fileName.includes("__")
      ? fileName.split(/__(.+)/)
      : [fileName, fileName];
    const instructionEntry = instructions.find((entry) => entry.id === imageId);
    const note = instructionEntry?.instruction?.toString().trim() || "";

    let normalized;
    try {
      normalized = await normalizeImageBuffer(file.buffer, file.mimetype);
    } catch (error) {
      const compressionError = new Error(
        "Unable to compress image under 10MB. Try a smaller file or reduce dimensions.",
      );
      compressionError.status = 413;
      throw compressionError;
    }

    references.push({
      id: imageId,
      originalName: instructionEntry?.originalName || originalName,
      prompt: note,
      dataUri: `data:${normalized.contentType};base64,${normalized.buffer.toString("base64")}`,
    });
  }

  const promptSegments = [prompt];
  const guidance = references
    .map((reference, index) =>
      reference.prompt
        ? `Image ${index + 1} (${reference.originalName}): ${reference.prompt}`
        : null
    )
    .filter(Boolean);

  if (guidance.length) {
    promptSegments.push(`Reference guidance:\n${guidance.join("\n")}`);
  }

  const finalPrompt = promptSegments.join("\n\n");

  try {
    if (provider === "nano-banana") {
      const { client, model } = ensureNanoBananaClient();
      const nanoParts = buildNanoBananaParts({
        references,
        finalPrompt,
        negativePrompt,
        sizeOption,
        aspectRatio,
        customWidth,
        customHeight,
        sequentialSetting,
        maxImages,
      });

      const generativeModel = client.getGenerativeModel({ model });
      const generation = await generativeModel.generateContent({
        contents: [
          {
            role: "user",
            parts: nanoParts,
          },
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "image/png",
        },
      });

      const nanoResponse = await generation.response;
      const { inlineImages, textPayloads } = extractNanoBananaOutputs(nanoResponse);
      const output = inlineImages.length
        ? inlineImages
        : textPayloads.length
        ? textPayloads.map((entry) =>
            `data:text/plain;base64,${Buffer.from(entry, "utf8").toString("base64")}`,
          )
        : [];

      if (!output.length) {
        throw new Error("Nano Banana returned no content");
      }

      res.json({
        status: "Nano Banana generation completed",
        output,
        prompt: finalPrompt,
        model,
        provider,
      });
      return;
    }

    if (provider === "replicate") {
      const replicate = ensureReplicate();
      const replicateIdentifier = await resolveModelIdentifier(replicate);

      const inputPayload = {
        prompt: finalPrompt,
        image_input: references.map((reference) => reference.dataUri),
      };

      if (negativePrompt) {
        inputPayload.negative_prompt = negativePrompt;
      }

      if (sizeOption) {
        inputPayload.size = sizeOption;
        if (sizeOption.toLowerCase() === "custom") {
          if (customWidth && customWidth >= 1024 && customWidth <= 4096) {
            inputPayload.width = customWidth;
          }
          if (customHeight && customHeight >= 1024 && customHeight <= 4096) {
            inputPayload.height = customHeight;
          }
        }
      }

      if (aspectRatio) {
        inputPayload.aspect_ratio = aspectRatio;
      }

    if (sequentialSetting) {
      inputPayload.sequential_image_generation = sequentialSetting;
      if (sequentialSetting === "auto" && maxImages && maxImages >= 1 && maxImages <= 15) {
        inputPayload.max_images = maxImages;
      }
    }

    const output = await replicate.run(replicateIdentifier, {
      input: inputPayload,
    });

      res.json({
        status: "Seedream generation completed",
        output,
        prompt: finalPrompt,
        model: replicateIdentifier,
      provider,
    });
    return;
  }

    if (provider === "fal") {
      const falClient = ensureFal();
      const falModel = process.env.FAL_MODEL || "fal-ai/bytedance/seedream/v4/edit";

      const referencesForFal = references.slice(-10);
      const falReferenceCount = referencesForFal.length;

      const isSequentialAuto = sequentialSetting === "auto";
      const requestedImages = isSequentialAuto && maxImages && maxImages > 1
        ? Math.min(maxImages, 15)
        : 1;
      const maxGeneratedImages = Math.max(1, 15 - Math.min(falReferenceCount, 15));
      const allowedGeneratedImages = Math.min(requestedImages, maxGeneratedImages);

      const falInput = {
        prompt: finalPrompt,
        negative_prompt: negativePrompt || undefined,
        enable_safety_checker: !disableSafetyFilter,
        num_images: allowedGeneratedImages,
      };

      if (allowedGeneratedImages > 1) {
        falInput.max_images = allowedGeneratedImages;
      }

      if (falReferenceCount) {
        const uploadedUrls = await Promise.all(
          referencesForFal.map((reference) => uploadReferenceToFal(falClient, reference)),
        );
        falInput.image_urls = uploadedUrls;
      }

      const falImageSize = computeFalImageSize(sizeOption, aspectRatio, customWidth, customHeight);
      if (falImageSize) {
        falInput.image_size = falImageSize;
      }

      if (Number.isInteger(falSeed)) {
        falInput.seed = falSeed;
      }

      if (falSyncMode) {
        falInput.sync_mode = true;
      }

      const { data: falData } = await falClient.subscribe(falModel, {
        input: falInput,
        logs: false,
      });

      const outputUrls = normalizeOutputUrls(falData);

      if (!outputUrls.length) {
        console.warn("Fal.ai returned no images", falData);
      }

      res.json({
        status: "fal.ai generation completed",
        output: outputUrls,
        prompt: finalPrompt,
        model: falModel,
        provider,
      });
      return;
    }

    throw new Error(`Unsupported provider: ${provider}`);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413) {
      const oversizeMessage =
        provider === "fal"
          ? "fal.ai rejected the request because it was too large. Try fewer or smaller reference images or lower the requested output count."
          : error.message ||
            "Unable to process image because it exceeds the 10MB post-compression limit.";
      return res.status(413).json({ error: oversizeMessage });
    }
    console.error("Generation failed", error);
    const detailMessage = (() => {
      const detail =
        (error && typeof error === "object" && "body" in error && error.body &&
          typeof error.body === "object" && "detail" in error.body
          ? error.body.detail
          : null);
      if (!detail) return null;
      try {
        if (Array.isArray(detail)) {
          return detail
            .map((entry) => {
              if (!entry) return null;
              if (typeof entry === "string") return entry;
              if (typeof entry === "object") {
                return entry.msg || entry.message || JSON.stringify(entry);
              }
              return String(entry);
            })
            .filter(Boolean)
            .join("; ");
        }
        if (typeof detail === "object") {
          return JSON.stringify(detail);
        }
        return String(detail);
      } catch {
        return null;
      }
    })();

    const message =
      detailMessage ||
      error?.error?.message ||
      error?.message ||
      (typeof error === "string" ? error : null) ||
      "Generation request failed";

    if (typeof message === "string" && message.toLowerCase().includes("content flagged")) {
      const reasonMatch = message.match(/content flagged for:?\s*(.+)$/i);
      const reasonLabel = reasonMatch ? reasonMatch[1] : "policy violation";
      const advisory = disableSafetyFilter
        ? `Replicate rejected this request even with the safety toggle enabled. Their platform still blocks ${reasonLabel}. Try softening explicit descriptors or remove sensitive elements.`
        : `Replicate blocked this request because it was flagged for ${reasonLabel}. Try softening explicit descriptors or remove sensitive elements.`;
      return res.status(422).json({ error: advisory });
    }

    if (provider === "fal") {
      const detail =
        (error && typeof error === "object" && "body" in error && error.body &&
          typeof error.body === "object" && "detail" in error.body
          ? error.body.detail
          : null);
      if (detail) {
        console.error("fal.ai validation detail", detail);
      }
    }

    res.status(500).json({ error: message });
  }
});

const clientDistPath = path.resolve(__dirname, "../frontend/dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Seedream server listening on port ${port}`);
});
