import {
  MAX_UPLOAD_SOURCE_BYTES,
  ensureNanoBananaConfig,
  error,
  fileToDataUri,
  getUserFromRequest,
  ok,
  resolveModelIdentifier,
  runReplicatePrediction,
} from "../_utils";

const MAX_REFERENCES_FOR_NANO = 4;

const parseBoolean = (value: FormDataEntryValue | null): boolean => {
  if (value === null || value === undefined) return false;
  const stringValue = value.toString().trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(stringValue);
};

const parseNumber = (value: FormDataEntryValue | null): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(value.toString(), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildNanoBananaParts = (
  references: Array<{ dataUri: string; originalName: string; prompt: string }>,
  finalPrompt: string,
  negativePrompt: string,
  sizeOption: string,
  aspectRatio: string,
  customWidth: number | null,
  customHeight: number | null,
  sequentialSetting: string,
  maxImages: number | null,
) => {
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  const limited = references.slice(0, MAX_REFERENCES_FOR_NANO);

  limited.forEach((reference, index) => {
    const match = reference.dataUri.match(/^data:(.+);base64,(.+)$/);
    if (match) {
      const [, mimeType, base64] = match;
      parts.push({ inlineData: { mimeType: mimeType || "image/png", data: base64 } });
      if (reference.prompt) {
        parts.push({
          text: `Reference ${index + 1} (${reference.originalName || `image-${index + 1}`}): ${reference.prompt}`,
        });
      }
    }
  });

  const guidance = references
    .map((reference, index) =>
      reference.prompt
        ? `Reference ${index + 1} (${reference.originalName || `image-${index + 1}`}): ${reference.prompt}`
        : null,
    )
    .filter(Boolean);

  const segments: string[] = [`PRIMARY_PROMPT:\n${finalPrompt}`];
  if (negativePrompt) {
    segments.push(`NEGATIVE_PROMPT:\n${negativePrompt}`);
  }
  if (guidance.length) {
    segments.push(`REFERENCE_GUIDANCE:\n${guidance.join("\n")}`);
  }
  if (sizeOption) {
    if (sizeOption.toLowerCase() === "custom" && customWidth && customHeight) {
      segments.push(`TARGET_RESOLUTION: ${customWidth}x${customHeight}`);
    } else {
      segments.push(`TARGET_RESOLUTION: ${sizeOption}`);
    }
  }
  if (aspectRatio) {
    segments.push(`TARGET_ASPECT_RATIO: ${aspectRatio}`);
  }
  if (sequentialSetting && sequentialSetting !== "disabled") {
    segments.push(`SEQUENTIAL_MODE: ${sequentialSetting}`);
  }
  if (maxImages && maxImages > 1) {
    segments.push(`REQUESTED_IMAGE_COUNT: ${maxImages}`);
  }

  parts.push({ text: segments.join("\n\n") });
  return parts;
};

const extractNanoBananaOutput = (payload: unknown): string[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> } }> }).candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  const outputs: string[] = [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "image/png";
        outputs.push(`data:${mimeType};base64,${part.inlineData.data}`);
      } else if (part.text) {
        outputs.push(`data:text/plain;base64,${btoa(part.text)}`);
      }
    }
  }
  return outputs;
};

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const user = await getUserFromRequest(request, env);
    const formData = await request.formData();

    const provider = (formData.get("provider")?.toString().toLowerCase() || "replicate") as
      | "replicate"
      | "fal"
      | "nano-banana";

    if (!["replicate", "fal", "nano-banana"].includes(provider)) {
      return error(`Unsupported provider: ${provider}`, 400);
    }

    const prompt = formData.get("prompt")?.toString().trim() || "";
    if (!prompt) {
      return error("Prompt is required", 400);
    }

    const negativePrompt = formData.get("negativePrompt")?.toString().trim() || "";
    const disableSafetyFilter = parseBoolean(formData.get("disableSafetyFilter"));
    const sizeOption = formData.get("size")?.toString() || "";
    const aspectRatio = formData.get("aspect_ratio")?.toString() || "";
    const sequentialSetting = formData.get("sequential_image_generation")?.toString() || "";
    const maxImages = parseNumber(formData.get("max_images"));
    const customWidth = parseNumber(formData.get("width"));
    const customHeight = parseNumber(formData.get("height"));
    const falSeed = parseNumber(formData.get("fal_seed"));
    const falSyncMode = parseBoolean(formData.get("fal_sync_mode"));

    const instructionsRaw = formData.get("instructions");
    let instructions: Array<{ id?: string; instruction?: string; originalName?: string }> = [];
    if (typeof instructionsRaw === "string") {
      try {
        const parsed = JSON.parse(instructionsRaw);
        if (Array.isArray(parsed)) {
          instructions = parsed;
        }
      } catch (parseError) {
        console.warn("Unable to parse instructions payload", parseError);
      }
    }

    const files = formData.getAll("images").filter((entry) => entry instanceof File) as File[];
    if (provider !== "nano-banana" && !files.length) {
      return error("At least one reference image is required", 400);
    }

    if (provider === "fal" && !files.length) {
      return error("fal.ai Seedream edit requires at least one reference image", 400);
    }

    const references: Array<{
      id: string;
      originalName: string;
      prompt: string;
      dataUri: string;
    }> = [];

    for (const file of files) {
      if (file.size > MAX_UPLOAD_SOURCE_BYTES) {
        return error("Unable to process image because it exceeds the 10MB limit", 413);
      }

      const serverFileName = file.name || `upload-${crypto.randomUUID()}`;
      const [imageId, originalName] = serverFileName.includes("__")
        ? serverFileName.split(/__(.+)/)
        : [crypto.randomUUID(), serverFileName];

      const instructionEntry = instructions.find((entry) => entry.id === imageId);
      const note = instructionEntry?.instruction?.toString().trim() || "";

      const { buffer, dataUri } = await fileToDataUri(file);
      const r2Key = `users/${user.id}/uploads/${Date.now()}-${serverFileName}`;
      await env.UPLOADS_BUCKET.put(r2Key, buffer, {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });

      references.push({
        id: imageId,
        originalName: instructionEntry?.originalName || originalName,
        prompt: note,
        dataUri,
      });
    }

    const guidance = references
      .map((reference, index) =>
        reference.prompt ? `Image ${index + 1} (${reference.originalName}): ${reference.prompt}` : null,
      )
      .filter(Boolean)
      .join("\n");

    const promptSegments = [prompt];
    if (guidance) {
      promptSegments.push(`Reference guidance:\n${guidance}`);
    }

    const finalPrompt = promptSegments.join("\n\n");

    if (provider === "nano-banana") {
      try {
        const { apiKey, model } = ensureNanoBananaConfig(env);
        const parts = buildNanoBananaParts(
          references,
          finalPrompt,
          negativePrompt,
          sizeOption,
          aspectRatio,
          customWidth,
          customHeight,
          sequentialSetting,
          maxImages,
        );

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts,
                },
              ],
              generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 768,
              },
            }),
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => response.statusText);
          return error(`Nano Banana (Gemini) error (${response.status}): ${text}`, 502);
        }

        const payload = await response.json();
        const output = extractNanoBananaOutput(payload);
        if (!output.length) {
          return error("Nano Banana returned no content", 500);
        }

        return ok({
          status: "Nano Banana generation completed",
          output,
          prompt: finalPrompt,
          model,
          provider,
        });
      } catch (nanoError) {
        console.error("Nano Banana generation failed", nanoError);
        const message = nanoError instanceof Error ? nanoError.message : "Nano Banana request failed";
        return error(message, 500);
      }
    }

    if (provider === "fal") {
      return error("fal.ai provider is not yet supported in the Cloudflare Pages deployment", 501);
    }

    // Default to Replicate
    const version = await resolveModelIdentifier(env);
    const replicateInput: Record<string, unknown> = {
      prompt: finalPrompt,
      image_input: references.map((reference) => reference.dataUri),
    };

    if (negativePrompt) {
      replicateInput.negative_prompt = negativePrompt;
    }
    if (sizeOption) {
      replicateInput.size = sizeOption;
      if (sizeOption.toLowerCase() === "custom") {
        if (customWidth && customWidth >= 1024 && customWidth <= 4096) {
          replicateInput.width = customWidth;
        }
        if (customHeight && customHeight >= 1024 && customHeight <= 4096) {
          replicateInput.height = customHeight;
        }
      }
    }
    if (aspectRatio) {
      replicateInput.aspect_ratio = aspectRatio;
    }
    if (sequentialSetting) {
      replicateInput.sequential_image_generation = sequentialSetting;
      if (sequentialSetting === "auto" && maxImages && maxImages >= 1 && maxImages <= 15) {
        replicateInput.max_images = maxImages;
      }
    }
    if (disableSafetyFilter) {
      replicateInput.enable_safety_checker = false;
    }

    const output = await runReplicatePrediction(env, version, replicateInput);

    return ok({
      status: "Seedream generation completed",
      output,
      prompt: finalPrompt,
      model: version,
      provider,
    });
  } catch (err) {
    console.error("Generation failed", err);
    const status = err instanceof Error && (err as Error & { status?: number }).status
      ? (err as Error & { status?: number }).status!
      : 500;
    const message = err instanceof Error ? err.message : "Generation request failed";
    return error(message, status);
  }
};
