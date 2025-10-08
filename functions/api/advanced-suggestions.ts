import { ensureGrokConfig, error, ok } from "../_utils";

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const payload = await request.json()
      .catch(() => null) as {
        cardKey?: string;
        template?: string;
        placeholders?: string[];
        fields?: Record<string, string>;
      } | null;

    const cardKey = payload?.cardKey || "card";
    const template = payload?.template?.toString() || "";
    const placeholders = Array.isArray(payload?.placeholders) ? payload!.placeholders : [];
    const fields = payload?.fields && typeof payload.fields === "object" ? payload.fields : {};

    if (!template || placeholders.length === 0) {
      return ok({ values: {}, preview: template });
    }

    const { apiKey, model, apiUrl } = ensureGrokConfig(env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const fieldContext = Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    const hint = `Provide production-ready values for the placeholders: ${placeholders.join(", ")}.`;

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
                "You are an advanced prompt engineering copilot. Given a template with placeholders, propose production-ready values. Return JSON with 'values' (object keyed by placeholder) and 'preview' (template with substitutions). Each value should include 'value' and 'explanation'.",
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
        const text = await response.text().catch(() => response.statusText);
        return error(`Grok API error (${response.status}): ${text}`, 502);
      }

      const payloadJson = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payloadJson.choices?.[0]?.message?.content?.trim() || "";
      if (!content) {
        return error("Grok response missing JSON body", 502);
      }

      let values = {} as Record<string, unknown>;
      let preview = template;
      try {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const jsonText = jsonMatch ? jsonMatch[1] : content;
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed === "object") {
          if (parsed.values && typeof parsed.values === "object") {
            values = parsed.values;
          }
          if (typeof parsed.preview === "string") {
            preview = parsed.preview;
          }
        }
      } catch (parseError) {
        console.warn("Unable to parse Grok advanced suggestion JSON", parseError);
      }

      return ok({
        cardKey,
        template,
        placeholders,
        values,
        preview,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("Advanced suggestion failed", err);
    const message = err instanceof Error ? err.message : "Unable to generate advanced suggestion";
    return error(message, 500);
  }
};
