import { getSupabaseForTables, getUserFromRequest, ok, error } from "../_utils";

const DEFAULT_SETTINGS = {
  preferredProviders: ["replicate"],
  sizeOption: "2K",
  aspectRatio: "match_input_image",
};

export const onRequestGet = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const user = await getUserFromRequest(request, env);
    const supabase = getSupabaseForTables(env);

    const { data, error: selectError } = await supabase
      .from("user_settings")
      .select("preferred_providers, size_option, aspect_ratio")
      .eq("user_id", user.id)
      .maybeSingle();

    if (selectError && selectError.code !== "PGRST116") {
      throw new Error(selectError.message);
    }

    const payload = data
      ? {
          preferredProviders: Array.isArray(data.preferred_providers)
            ? data.preferred_providers
            : DEFAULT_SETTINGS.preferredProviders,
          sizeOption: data.size_option || DEFAULT_SETTINGS.sizeOption,
          aspectRatio: data.aspect_ratio || DEFAULT_SETTINGS.aspectRatio,
        }
      : DEFAULT_SETTINGS;

    return ok(payload);
  } catch (err) {
    console.error("Failed to load user settings", err);
    const status = err instanceof Error && (err as Error & { status?: number }).status
      ? (err as Error & { status?: number }).status!
      : 500;
    const message = err instanceof Error ? err.message : "Unable to load user settings";
    return error(message, status);
  }
};

export const onRequestPut = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const user = await getUserFromRequest(request, env);
    const body = await request
      .json()
      .catch(() => null) as {
        preferredProviders?: unknown;
        sizeOption?: unknown;
        aspectRatio?: unknown;
      } | null;

    if (!body) {
      return error("Invalid request body", 400);
    }

    const preferredProviders = Array.isArray(body.preferredProviders)
      ? body.preferredProviders.filter((item) => typeof item === "string")
      : DEFAULT_SETTINGS.preferredProviders;

    const sizeOption = typeof body.sizeOption === "string" && body.sizeOption.trim().length
      ? body.sizeOption.trim()
      : DEFAULT_SETTINGS.sizeOption;

    const aspectRatio = typeof body.aspectRatio === "string" && body.aspectRatio.trim().length
      ? body.aspectRatio.trim()
      : DEFAULT_SETTINGS.aspectRatio;

    const supabase = getSupabaseForTables(env);
    const { error: upsertError } = await supabase.from("user_settings").upsert(
      {
        user_id: user.id,
        preferred_providers: preferredProviders,
        size_option: sizeOption,
        aspect_ratio: aspectRatio,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (upsertError) {
      throw new Error(upsertError.message);
    }

    return ok({ status: "settings saved" });
  } catch (err) {
    console.error("Failed to save user settings", err);
    const status = err instanceof Error && (err as Error & { status?: number }).status
      ? (err as Error & { status?: number }).status!
      : 500;
    const message = err instanceof Error ? err.message : "Unable to save user settings";
    return error(message, status);
  }
};
