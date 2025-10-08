import { ensureGrokConfig, error, ok } from "../_utils";

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const payload = await request.json()
      .catch(() => null) as { prompt?: string; fields?: Record<string, string> } | null;

    const userPrompt = payload?.prompt?.toString() || "";
    const fields = payload?.fields && typeof payload.fields === "object" ? payload.fields : {};

    const { apiKey, model, apiUrl } = ensureGrokConfig(env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const context = Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    try {
      const response = await fetch(apiUrl, {
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
                "You are a senior cinematic prompt designer for Seedream-4. Create three prompt blueprints using the advanced formula (intent, subject, action, camera, lighting, environment, texture, composition, negative). Respond strictly with JSON containing 'recommended' and an 'alternatives' array (length 2).",
            },
            {
              role: "user",
              content: `User prompt: ${userPrompt || "(none provided)"}\nExisting context:\n${context || "(none)"}`,
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
      if (!content) {
        return error("Grok response missing JSON body", 502);
      }

      try {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const jsonText = jsonMatch ? jsonMatch[1] : content;
        const parsed = JSON.parse(jsonText);
        return ok({
          recommended: parsed?.recommended || null,
          alternatives: Array.isArray(parsed?.alternatives) ? parsed.alternatives : [],
        });
      } catch (parseError) {
        console.warn("Unable to parse Grok blueprint JSON", parseError);
        return error("Invalid JSON response for blueprints", 500);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("Advanced blueprint generation failed", err);
    const message = err instanceof Error ? err.message : "Unable to generate blueprint prompts";
    return error(message, 500);
  }
};
