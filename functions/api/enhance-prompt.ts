import {
  ensureGrokConfig,
  error,
  ok,
} from "../_utils";

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const payload = await request.json()
      .catch(() => null) as { prompt?: string; negativePrompt?: string; instructions?: Array<{ originalName?: string; instruction?: string }> } | null;

    const basePrompt = payload?.prompt?.toString().trim() || "";
    const negativePrompt = payload?.negativePrompt?.toString().trim() || "";
    const instructions = Array.isArray(payload?.instructions) ? payload!.instructions : [];

    if (!basePrompt) {
      return error("Prompt is required", 400);
    }

    const { apiKey, model, apiUrl } = ensureGrokConfig(env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const guidanceSegment = instructions.length
      ? instructions
          .map((entry, index) => `Reference ${index + 1} (${entry.originalName || "reference"}): ${entry.instruction || "no additional guidance"}`)
          .join("\n")
      : "none provided";

    try {
      const response = await fetch(apiUrl, {
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
              content: `BASE_PROMPT:\n${basePrompt}\n\nNEGATIVE_PROMPT:\n${negativePrompt || "(none)"}\n\nREFERENCE_GUIDANCE:\n${guidanceSegment}`,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        return error(`Grok API error (${response.status}): ${text}`, 502);
      }

      const payloadJson = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payloadJson.choices?.[0]?.message?.content?.trim() || "";
      let enhancedPrompt = basePrompt;
      let enhancedNegative = negativePrompt;

      if (content) {
        try {
          const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
          const jsonText = jsonMatch ? jsonMatch[1] : content;
          const parsed = JSON.parse(jsonText);
          if (typeof parsed?.enhancedPrompt === "string" && parsed.enhancedPrompt.trim()) {
            enhancedPrompt = parsed.enhancedPrompt.trim();
          }
          if (typeof parsed?.negativePrompt === "string") {
            enhancedNegative = parsed.negativePrompt.trim();
          }
        } catch (parseError) {
          console.warn("Unable to parse Grok enhancement JSON", parseError);
        }
      }

      return ok({
        status: "Prompt enhanced",
        prompt: enhancedPrompt,
        negativePrompt: enhancedNegative,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("Prompt enhancement failed", err);
    const message = err instanceof Error ? err.message : "Unable to enhance prompt";
    return error(message, 500);
  }
};
