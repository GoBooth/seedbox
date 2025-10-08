import {
  MAX_REMOTE_IMPORT_SOURCE_BYTES,
  arrayBufferToBase64,
  error,
  ok,
} from "../_utils";

export const onRequestPost = async ({ request, env }: { request: Request; env: any }) => {
  try {
    const payload = (await request
      .json()
      .catch(() => null)) as { url?: string } | null;
    const url = payload?.url?.trim();
    if (!url) {
      return error("Image URL is required", 400);
    }

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      return error(`Unable to fetch image (status ${response.status})`, 400);
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) {
      return error("URL does not point to an image resource", 400);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_REMOTE_IMPORT_SOURCE_BYTES) {
      return error("Remote image is too large to process", 413);
    }

    const key = `remote/${Date.now()}-${crypto.randomUUID()}`;
    await env.UPLOADS_BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType },
    });

    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUri = `data:${contentType};base64,${base64}`;
    const fileNameFromUrl = url.split("/").pop() || "remote-image";
    const fallbackName = fileNameFromUrl.split("?")[0] || "remote-image";

    return ok({
      status: "ok",
      fileName: fallbackName,
      contentType,
      dataUri,
      r2Key: key,
    });
  } catch (err) {
    console.error("Import image failed", err);
    return error("Unable to import remote image", 500);
  }
};
