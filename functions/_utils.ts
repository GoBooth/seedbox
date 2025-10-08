import { createClient, type User } from "@supabase/supabase-js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_REMOTE_IMPORT_SOURCE_BYTES = 80 * 1024 * 1024;

export interface Env {
  REPLICATE_API_TOKEN?: string;
  SEEDREAM4_MODEL_VERSION?: string;
  SEEDREAM_MODEL_VERSION?: string;
  FAL_KEY?: string;
  FAIAI_API_TOKEN?: string;
  FAL_MODEL?: string;
  XAI_API_KEY?: string;
  GROK_API_MODEL?: string;
  GROK_MODEL?: string;
  GROK_API_BASE_URL?: string;
  GROK_API_KEY?: string;
  GROK_API_TIMEOUT_MS?: string;
  NANO_BANANA_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  NANO_BANANA_MODEL?: string;
  ENABLE_GEMINI?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  UPLOADS_BUCKET: any;
}

const DEFAULT_MODEL_SLUG = "bytedance/seedream-4";
const DEFAULT_GROK_MODEL = "grok-4-fast";
const DEFAULT_GROK_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_NANO_BANANA_MODEL = "gemini-1.5-flash";

export const ok = (data: unknown, init: ResponseInit = {}) =>
  Response.json(data, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });

export const error = (message: string, status = 400) =>
  ok({ error: message }, { status });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

export const fileToDataUri = async (file: File): Promise<{ dataUri: string; buffer: ArrayBuffer }> => {
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const mimeType = file.type || "application/octet-stream";
  return {
    buffer,
    dataUri: `data:${mimeType};base64,${base64}`,
  };
};

const requireEnv = (env: Env, key: keyof Env): string => {
  const value = env[key];
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error(`${String(key)} is not configured.`);
  }
  return value.trim();
};

let cachedModelIdentifier: string | null = null;
let cachedModelSource: string | null = null;

const fetchReplicateJson = async (env: Env, input: RequestInfo, init?: RequestInit) => {
  const token = requireEnv(env, "REPLICATE_API_TOKEN");
  const response = await fetch(input, {
    ...init,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Replicate API error (${response.status}): ${text}`);
  }
  return response.json();
};

export const resolveModelIdentifier = async (env: Env): Promise<string> => {
  const source = env.SEEDREAM4_MODEL_VERSION || env.SEEDREAM_MODEL_VERSION || DEFAULT_MODEL_SLUG;

  if (cachedModelIdentifier && cachedModelSource === source) {
    return cachedModelIdentifier;
  }

  if (source.includes(":")) {
    cachedModelIdentifier = source;
    cachedModelSource = source;
    return cachedModelIdentifier;
  }

  const [owner, name] = source.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid model slug: ${source}`);
  }

  const model = await fetchReplicateJson(env, `https://api.replicate.com/v1/models/${owner}/${name}`);
  let versionId = model?.latest_version?.id as string | undefined;

  if (!versionId) {
    const versions = await fetchReplicateJson(env, `https://api.replicate.com/v1/models/${owner}/${name}/versions`);
    versionId = versions?.results?.[0]?.id;
  }

  if (!versionId) {
    throw new Error("Unable to resolve Seedream-4 model version");
  }

  cachedModelIdentifier = versionId;
  cachedModelSource = source;
  return versionId;
};

export const runReplicatePrediction = async (env: Env, version: string, input: Record<string, unknown>) => {
  const prediction = await fetchReplicateJson(env, "https://api.replicate.com/v1/predictions", {
    method: "POST",
    body: JSON.stringify({ version, input }),
  });

  let pollingUrl: string | undefined = prediction?.urls?.get;
  let status: string = prediction?.status;

  while (pollingUrl && (status === "starting" || status === "processing")) {
    await sleep(1500);
    const latest = await fetchReplicateJson(env, pollingUrl);
    status = latest?.status;
    pollingUrl = latest?.urls?.get;
    if (status === "succeeded") {
      return latest?.output ?? [];
    }
    if (status === "failed" || status === "canceled") {
      throw new Error(latest?.error ?? "Replicate request failed");
    }
  }

  if (status === "succeeded") {
    return prediction?.output ?? [];
  }

  throw new Error("Replicate prediction did not complete successfully");
};

export const runFalGeneration = async (
  env: Env,
  model: string,
  input: Record<string, unknown>,
): Promise<string[]> => {
  const token = (env.FAIAI_API_TOKEN || env.FAL_KEY || "").trim();
  if (!token) {
    throw new Error("FAIAI_API_TOKEN (or FAL_KEY) is not configured.");
  }
  const startResponse = await fetch(`https://api.fal.ai/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  if (!startResponse.ok) {
    const text = await startResponse.text();
    throw new Error(`fal.ai error (${startResponse.status}): ${text}`);
  }

  const startPayload = (await startResponse.json()) as { request_id?: string };
  const requestId = startPayload.request_id;
  if (!requestId) {
    throw new Error("fal.ai response missing request_id");
  }

  const statusUrl = `https://api.fal.ai/requests/${requestId}`;
  while (true) {
    await sleep(1500);
    const statusResponse = await fetch(statusUrl, {
      headers: { Authorization: `Key ${token}` },
    });
    if (!statusResponse.ok) {
      const text = await statusResponse.text();
      throw new Error(`fal.ai polling error (${statusResponse.status}): ${text}`);
    }
    const statusPayload = (await statusResponse.json()) as {
      status?: string;
      response?: { output?: Array<{ url?: string } | string> };
      error?: string;
    };
    const state = statusPayload.status;
    if (state === "COMPLETED" || state === "succeeded") {
      const output = statusPayload.response?.output ?? [];
      return normalizeOutputUrls(output);
    }
    if (state === "FAILED" || state === "error") {
      throw new Error(statusPayload.error || "fal.ai request failed");
    }
  }
};

const normalizeOutputUrls = (output: unknown): string[] => {
  if (!output) return [];
  if (Array.isArray(output)) {
    return output.flatMap(normalizeOutputUrls);
  }
  if (typeof output === "string") {
    return [output];
  }
  if (typeof output === "object" && output !== null) {
    const maybeUrl = (output as { url?: string; image_url?: string; image?: { url?: string } }).url;
    if (maybeUrl) return [maybeUrl];
    const imageUrl = (output as { image_url?: string }).image_url;
    if (imageUrl) return [imageUrl];
    const nested = (output as { image?: { url?: string } }).image;
    if (nested?.url) return [nested.url];
    if (Array.isArray((output as { images?: unknown[] }).images)) {
      return (output as { images: unknown[] }).images.flatMap(normalizeOutputUrls);
    }
    if (Array.isArray((output as { output?: unknown[] }).output)) {
      return (output as { output: unknown[] }).output.flatMap(normalizeOutputUrls);
    }
  }
  return [];
};

export const ensureGrokConfig = (env: Env) => {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is not configured.");
  }
  const model = env.GROK_MODEL || env.GROK_API_MODEL || DEFAULT_GROK_MODEL;
  const apiUrl = env.GROK_API_BASE_URL || DEFAULT_GROK_URL;
  return { apiKey: apiKey.trim(), model, apiUrl };
};

export const ensureNanoBananaConfig = (env: Env) => {
  if (env.ENABLE_GEMINI && env.ENABLE_GEMINI.toLowerCase() === "false") {
    throw new Error("Nano Banana provider is disabled.");
  }
  const apiKey = env.NANO_BANANA_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  const model = env.NANO_BANANA_MODEL || DEFAULT_NANO_BANANA_MODEL;
  return { apiKey: apiKey.trim(), model };
};

const getSupabaseServiceClient = (env: Env) => {
  const url = requireEnv(env, "SUPABASE_URL");
  const key = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: fetch.bind(globalThis) },
  });
};

export const getUserFromRequest = async (request: Request, env: Env): Promise<User> => {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    const unauthorized = new Error("Unauthorized: missing access token");
    (unauthorized as Error & { status?: number }).status = 401;
    throw unauthorized;
  }

  const supabase = getSupabaseServiceClient(env);
  const { data, error: authError } = await supabase.auth.getUser(token);

  if (authError || !data?.user) {
    const unauthorized = new Error(authError?.message || "Unauthorized");
    (unauthorized as Error & { status?: number }).status = 401;
    throw unauthorized;
  }

  return data.user;
};

export const getSupabaseForTables = (env: Env) => getSupabaseServiceClient(env);

export { arrayBufferToBase64, requireEnv, sleep, normalizeOutputUrls };
