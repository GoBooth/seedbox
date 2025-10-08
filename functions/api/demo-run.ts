import {
  error,
  getUserFromRequest,
  ok,
  resolveModelIdentifier,
  runReplicatePrediction,
} from "../_utils";

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    await getUserFromRequest(request, env);
    const payload = (await request.json().catch(() => null)) as {
      prompt?: string;
      aspect_ratio?: string;
    } | null;
    const prompt = payload?.prompt?.toString().trim() || "";
    const aspectRatio = payload?.aspect_ratio?.toString() || "match_input_image";

    if (!prompt) {
      return error("Prompt is required", 400);
    }

    const version = await resolveModelIdentifier(env);
    const output = await runReplicatePrediction(env, version, {
      prompt,
      aspect_ratio: aspectRatio,
    });

    return ok({
      status: "Seedream demo completed",
      output,
      prompt,
      aspect_ratio: aspectRatio,
      model: version,
    });
  } catch (err) {
    console.error("Seedream demo failed", err);
    const status = err instanceof Error && (err as Error & { status?: number }).status
      ? (err as Error & { status?: number }).status!
      : 500;
    const message = err instanceof Error ? err.message : "Unable to reach Replicate";
    return error(message, status);
  }
};
