import { ok } from "../_utils";

export const onRequestGet = async ({ env }: { env: any }) => {
  return ok({
    status: "ok",
    modelVersion: env.SEEDREAM4_MODEL_VERSION || env.SEEDREAM_MODEL_VERSION || "latest",
  });
};
