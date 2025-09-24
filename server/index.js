import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import Replicate from "replicate";

dotenv.config();

const app = express();
const port = parseInt(process.env.PORT || "5000", 10);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : undefined,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 6,
    fileSize: 10 * 1024 * 1024,
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

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    modelVersion: process.env.SEEDREAM4_MODEL_VERSION || null,
  });
});

app.post("/api/generate", upload.array("images"), async (req, res) => {
  const prompt = (req.body?.prompt || "").toString().trim();
  const negativePrompt = (req.body?.negativePrompt || "").toString().trim();
  const instructionsRaw = req.body?.instructions;
  const files = req.files || [];

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  if (!files.length) {
    return res.status(400).json({ error: "At least one reference image is required" });
  }

  const instructions = resolveInstructions(instructionsRaw);

  const references = files.map((file) => {
    const fileName = file.originalname || file.fieldname;
    const [imageId, originalName] = fileName.includes("__")
      ? fileName.split(/__(.+)/)
      : [fileName, fileName];
    const instructionEntry = instructions.find((entry) => entry.id === imageId);
    const note = instructionEntry?.instruction?.toString().trim() || "";

    return {
      id: imageId,
      originalName: instructionEntry?.originalName || originalName,
      prompt: note,
      dataUri: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
    };
  });

  const replicateVersion =
    process.env.SEEDREAM4_MODEL_VERSION || process.env.SEEDREAM_MODEL_VERSION;

  if (!replicateVersion) {
    return res
      .status(500)
      .json({ error: "Server misconfiguration: missing Seedream model version" });
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
    const replicate = ensureReplicate();

    const inputPayload = {
      prompt: finalPrompt,
      reference_images: references.map((reference) => reference.dataUri),
      reference_prompts: references.map((reference) => reference.prompt),
    };

    if (negativePrompt) {
      inputPayload.negative_prompt = negativePrompt;
    }

    const output = await replicate.run(replicateVersion, {
      input: inputPayload,
    });

    res.json({
      status: "Seedream generation completed",
      output,
      prompt: finalPrompt,
    });
  } catch (error) {
    console.error("Seedream generation failed", error);
    const message =
      (error?.error?.message ||
        error?.message ||
        (typeof error === "string" ? error : null) ||
        "Unable to reach Replicate") as string;

    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Seedream server listening on port ${port}`);
});
