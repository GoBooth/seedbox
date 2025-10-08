import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import { buildApiUrl } from "./lib/api";

type UploadedImage = {
  id: string;
  file: File;
  preview: string;
  instruction: string;
  originalName: string;
  signature: string;
};

type GenerationResponse = {
  output?: string[] | string;
  status?: string;
  logs?: string;
  provider?: string;
  model?: string;
};

type GeneratedResult = {
  id: string;
  url: string;
  provider: string;
  model?: string | null;
  basename: string;
  createdAt: number;
};

type SavedCharacter = {
  id: string;
  name: string;
  dataUri: string;
  contentType: string;
  instruction: string;
  createdAt: number;
};

type SavedPrompt = {
  id: string;
  name: string;
  prompt: string;
  negativePrompt: string;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  thumbnail?: string;
};

const sizeOptions = [
  { value: "1K", label: "1K · 1024px" },
  { value: "2K", label: "2K · 2048px" },
  { value: "4K", label: "4K · 4096px" },
  { value: "custom", label: "Custom dimensions" },
];

const aspectRatioOptions = [
  { value: "match_input_image", label: "Match reference image" },
  { value: "1:1", label: "1:1 (square)" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "21:9", label: "21:9" },
];

const sequentialModes = [
  { value: "disabled", label: "Disabled (single image)" },
  { value: "auto", label: "Auto (model decides)" },
];

const computeDefaultMaxImages = (mode: string) => (mode === "auto" ? 3 : 1);
const RESULTS_STORAGE_KEY = "seedream.results";
const PROVIDERS_STORAGE_KEY = "seedream.providers";
const CHARACTERS_STORAGE_KEY = "seedream.characters";
const PROMPT_LIBRARY_STORAGE_KEY = "seedream.prompts";

const providerOptions = [
  { value: "replicate", label: "Replicate · Seedream-4" },
  { value: "nano-banana", label: "Nano Banana · Gemini Flash" },
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const INSTRUCTION_STORAGE_KEY = "seedream.instructions";

type SeedreamGuideline = {
  title: string;
  summary: string;
  bullets: string[];
};

const SEEDREAM_GUIDELINES: SeedreamGuideline[] = [
  {
    title: "Core strengths",
    summary:
      "Seedream 4 unifies high-resolution generation, reference-based editing, and batching in a single pipeline.",
    bullets: [
      "Produce 2K frames quickly and upscale to 4K when you need final polish.",
      "Mix text prompts with up to 10 reference images to keep style and character identity consistent.",
      "Return as many as 15 related images in one run for storyboards, catalogs, or mood boards.",
    ],
  },
  {
    title: "Prompt formula",
    summary:
      "Lead with an action, the target object, and the attributes you expect Seedream to respect.",
    bullets: [
      "Structure prompts as action + object + attributes (\"Add a golden helmet to the knight\").",
      "Describe edits in natural language such as \"remove the background\" or \"replace the outfit\".",
      "Call out style, lighting, or medium (\"in ukiyo-e style\", \"cyberpunk lighting\", \"watercolor illustration\").",
    ],
  },
  {
    title: "Reference & batch guidance",
    summary:
      "Use references and language cues to steer cohesion across large sets of images.",
    bullets: [
      "When blending sources, mention which elements come from each reference image.",
      "Use cues like \"series\", \"set\", or \"batch of four\" to request multi-image outputs (up to 15).",
      "Repeat key traits in text so Seedream keeps faces, outfits, and props aligned with your references.",
    ],
  },
  {
    title: "Constraints & iteration",
    summary:
      "Tell the model what must stay fixed and iterate with short follow-up instructions.",
    bullets: [
      "Explicitly state what cannot change (\"Keep the woman's facial features and jacket\").",
      "Adjust environments, lighting, or camera moves with single edits like \"shift to sunset warm lighting\".",
      "Iterate after each run: issue refinements such as \"reduce surface glare\" or \"add volumetric fog\".",
    ],
  },
];

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

const computeSignature = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;

const createUploadedImage = (file: File, signatureMap: Record<string, string>) => {
  const signature = computeSignature(file);
  return {
    id: createId(),
    file,
    originalName: file.name,
    instruction: signatureMap[signature] ?? "",
    preview: URL.createObjectURL(file),
    signature,
  };
};

const dataUriToFile = async (dataUri: string, fileName: string, contentType: string) => {
  const response = await fetch(dataUri);
  const blob = await response.blob();
  const inferredName = fileName.includes('.') ? fileName : `${fileName}.${contentType.split('/')[1] || 'png'}`;
  return new File([blob], inferredName, { type: contentType, lastModified: Date.now() });
};

const fileToDataUri = (file: File): Promise<{ dataUri: string; contentType: string }> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve({ dataUri: result, contentType: file.type || "application/octet-stream" });
      } else {
        reject(new Error("Unable to read file"));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<string[]>(() => {
    if (typeof window === "undefined") {
      return ["replicate"];
    }

    try {
      const raw = window.localStorage.getItem(PROVIDERS_STORAGE_KEY);
      if (!raw) return ["replicate"];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((item) =>
          typeof item === "string" && providerOptions.some((option) => option.value === item)
        );
        return filtered.length ? Array.from(new Set(filtered)) : ["replicate"];
      }
    } catch (error) {
      console.warn("Unable to restore provider selection", error);
    }

    return ["replicate"];
  });
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [results, setResults] = useState<GeneratedResult[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }

    try {
      const raw = window.localStorage.getItem(RESULTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized: GeneratedResult[] = [];
        const now = Date.now();
        for (let index = 0; index < parsed.length; index += 1) {
          const entry = parsed[index];
          if (typeof entry === "string") {
            normalized.push({
              id: `restored-${now}-${index}-${Math.random().toString(16).slice(2)}`,
              url: entry,
              provider: "replicate",
              model: null,
              basename: "seedream-output",
              createdAt: now - index,
            });
            continue;
          }

          if (entry && typeof entry === "object" && typeof entry.url === "string") {
            const candidateId = (entry as { id?: unknown }).id;
            const restoredId =
              typeof candidateId === "string" && candidateId.trim().length
                ? candidateId
                : `restored-${now}-${index}-${Math.random().toString(16).slice(2)}`;
            const candidateBase = (entry as { basename?: unknown }).basename;
            const restoredBase =
              typeof candidateBase === "string" && candidateBase.trim().length
                ? candidateBase
                : "seedream-output";
            normalized.push({
              id: restoredId,
              url: entry.url,
              provider: typeof entry.provider === "string" ? entry.provider : "replicate",
              model: typeof entry.model === "string" ? entry.model : null,
              basename: restoredBase,
              createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now - index,
            });
          }
        }
        return normalized.slice(0, 60);
      }
    } catch (error) {
      console.warn("Unable to restore cached results", error);
      return [];
    }

    return [];
  });
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [instructionClipboard, setInstructionClipboard] = useState<{
    text: string;
    source: string;
  } | null>(null);
  const [instructionStore, setInstructionStore] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") {
      return {};
    }

    try {
      const raw = window.localStorage.getItem(INSTRUCTION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const record: Record<string, string> = {};
        Object.entries(parsed).forEach(([key, value]) => {
          if (typeof value === "string") {
            record[key] = value;
          }
        });
        return record;
      }
    } catch (error) {
      console.warn("Unable to restore instruction cache", error);
    }

    return {};
  });
  const [characters, setCharacters] = useState<SavedCharacter[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }

    try {
      const raw = window.localStorage.getItem(CHARACTERS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.dataUri === "string" &&
            typeof entry.name === "string"
          )
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : createId(),
            name: entry.name,
            dataUri: entry.dataUri,
            contentType:
              typeof entry.contentType === "string" ? entry.contentType : "image/png",
            instruction: typeof entry.instruction === "string" ? entry.instruction : "",
            createdAt:
              typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          }));
      }
    } catch (error) {
      console.warn("Unable to restore character library", error);
    }

    return [];
  });
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const payload = results.slice(0, 60).map((result) => ({
        id: result.id,
        url: result.url,
        provider: result.provider,
        model: result.model,
        createdAt: result.createdAt,
      }));
      window.localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("Unable to persist generated results", error);
    }
  }, [results]);
  const [promptLibrary, setPromptLibrary] = useState<SavedPrompt[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }

    try {
      const raw = window.localStorage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.prompt === "string"
          )
          .map((entry) => {
            const id = typeof entry.id === "string" ? entry.id : createId();
            const createdAt =
              typeof entry.createdAt === "number" ? entry.createdAt : Date.now();
            const updatedAt =
              typeof entry.updatedAt === "number" ? entry.updatedAt : createdAt;
            const thumbnail =
              typeof entry.thumbnail === "string" && entry.thumbnail.trim().length
                ? entry.thumbnail.trim()
                : undefined;
            const usageCount =
              typeof entry.usageCount === "number" && entry.usageCount >= 0
                ? entry.usageCount
                : 0;

            return {
              id,
              name: typeof entry.name === "string" ? entry.name : "Saved prompt",
              prompt: entry.prompt,
              negativePrompt:
                typeof entry.negativePrompt === "string" ? entry.negativePrompt : "",
              createdAt,
              updatedAt,
              usageCount,
              thumbnail,
            } as SavedPrompt;
          });
      }
    } catch (error) {
      console.warn("Unable to restore prompt library", error);
    }

    return [];
  });
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [safetyCheckDisabled, setSafetyCheckDisabled] = useState(true);
  const [size, setSize] = useState("2K");
  const [aspectRatio, setAspectRatio] = useState("match_input_image");
  const [importUrl, setImportUrl] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [sequentialMode, setSequentialMode] = useState("disabled");
  const [maxImages, setMaxImages] = useState<number>(computeDefaultMaxImages("disabled"));
  const [customWidth, setCustomWidth] = useState<number>(2048);
  const [customHeight, setCustomHeight] = useState<number>(2048);
  const [showAdvancedPrompt, setShowAdvancedPrompt] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [lastUsedPromptId, setLastUsedPromptId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const activeProviders = selectedProviders.length ? selectedProviders : ["replicate"];
  const hasImages = images.length > 0;
  const isCustomSize = size === "custom";
  const isSequentialAuto = sequentialMode === "auto";

  const getProviderLabel = (value: string) =>
    providerOptions.find((option) => option.value === value)?.label || value;

  const closeAdvancedPrompt = () => {
    setShowAdvancedPrompt(false);
  };

  const hasSelectedResults = selectedResultIds.size > 0;
  const allResultsSelected = results.length > 0 && selectedResultIds.size === results.length;

  useEffect(() => {
    setSelectedResultIds((previous) => {
      if (!previous.size) {
        return previous;
      }
      const available = new Set(results.map((result) => result.id));
      let changed = false;
      const next = new Set<string>();
      previous.forEach((id) => {
        if (available.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      if (!changed && next.size === previous.size) {
        return previous;
      }
      return next;
    });
  }, [results]);

  const toggleResultSelection = (id: string) => {
    setSelectedResultIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleSelectAllResults = () => {
    if (!results.length) {
      setSelectedResultIds(new Set());
      return;
    }
    setSelectedResultIds((previous) => {
      if (previous.size === results.length) {
        return new Set();
      }
      return new Set(results.map((result) => result.id));
    });
  };

  const sanitizeBasename = (name: string) => {
    const trimmed = name.replace(/\.[^/.]+$/, "").trim();
    if (!trimmed) {
      return "seedream-output";
    }
    const cleaned = trimmed.replace(/[^a-zA-Z0-9-_]+/g, "_");
    const collapsed = cleaned.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return collapsed || "seedream-output";
  };

  const guessFileExtension = (url: string, mimeType?: string) => {
    if (mimeType) {
      const lower = mimeType.toLowerCase();
      if (lower.includes("png")) return "png";
      if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
      if (lower.includes("webp")) return "webp";
      if (lower.includes("gif")) return "gif";
      if (lower.includes("mp4")) return "mp4";
    }
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
      if (match) {
        return match[1].toLowerCase();
      }
    } catch (error) {
      // ignore
    }
    if (mimeType && mimeType.toLowerCase().includes("video")) {
      return "mp4";
    }
    return "png";
  };

  const createDownloadFilename = (result: GeneratedResult, extension: string, index: number) => {
    const base = result.basename || "seedream-output";
    const timestamp = new Date(result.createdAt).toISOString().replace(/[:.]/g, "-");
    return `${base}-${result.provider}-${timestamp}-${index + 1}.${extension}`;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  const handleDownloadSelectedResults = async () => {
    const targets = results.filter((result) => selectedResultIds.has(result.id));
    if (!targets.length) {
      setStatusMessage("Select generated images to download.");
      return;
    }
    setErrorMessage(null);
    setIsDownloading(true);
    try {
      setStatusMessage(`Downloading ${targets.length} file${targets.length === 1 ? "" : "s"}…`);
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const response = await fetch(target.url, { mode: "cors" });
        if (!response.ok) {
          throw new Error(`Failed to download image (status ${response.status})`);
        }
        const blob = await response.blob();
        const extension = guessFileExtension(target.url, blob.type);
        const filename = createDownloadFilename(target, extension, index);
        downloadBlob(blob, filename);
      }
      setStatusMessage(`Downloaded ${targets.length} file${targets.length === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Download failed", error);
      setErrorMessage(error instanceof Error ? error.message : "Unable to download selected images.");
      setStatusMessage("");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleRemoveResult = (id: string) => {
    const filtered = results.filter((result) => result.id !== id);
    if (filtered.length === results.length) {
      return;
    }
    setResults(filtered);
    setSelectedResultIds((previous) => {
      if (!previous.has(id)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setLightboxIndex((current) => {
      if (current === null) return current;
      if (!filtered.length) return null;
      const removedIndex = results.findIndex((result) => result.id === id);
      if (removedIndex === -1) {
        return Math.min(current, filtered.length - 1);
      }
      if (current >= filtered.length) {
        return filtered.length - 1;
      }
      if (removedIndex <= current) {
        return Math.max(0, current - 1);
      }
      return current;
    });
    setStatusMessage("Removed generated image.");
  };

  const handleRemoveSelectedResults = () => {
    const idsToRemove = Array.from(selectedResultIds);
    if (!idsToRemove.length) {
      setStatusMessage("Select generated images to remove.");
      return;
    }
    const removeSet = new Set(idsToRemove);
    const filtered = results.filter((result) => !removeSet.has(result.id));
    if (filtered.length === results.length) {
      setStatusMessage("Select generated images to remove.");
      return;
    }
    const removedCount = results.length - filtered.length;
    setResults(filtered);
    setSelectedResultIds(new Set());
    setLightboxIndex((current) => {
      if (current === null) return current;
      if (!filtered.length) {
        return null;
      }
      return Math.min(current, filtered.length - 1);
    });
    setStatusMessage(`Removed ${removedCount} generated image${removedCount === 1 ? "" : "s"}.`);
  };


  const instructionChecklist = useMemo(
    () =>
      images.map((image, index) => ({
        index: index + 1,
        name: image.originalName,
        instruction: image.instruction,
      })),
    [images],
  );


  const addFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;

    let rejected = false;
    const sizeFiltered = incoming.filter((file) => {
      if (file.size <= MAX_FILE_SIZE) {
        return true;
      }
      rejected = true;
      return false;
    });

    if (rejected) {
      setErrorMessage("Each reference image must be 10MB or smaller.");
    }

    if (!sizeFiltered.length) {
      return;
    }

    setImages((previous) => {
      const deduplicated = sizeFiltered.filter((file) =>
        !previous.some(
          (existing) =>
            existing.file.name === file.name &&
            existing.file.size === file.size &&
            existing.file.lastModified === file.lastModified,
        ),
      );

      if (!deduplicated.length) {
        return previous;
      }

      const mapped = deduplicated.map((file) =>
        createUploadedImage(file, instructionStore),
      );

      setErrorMessage(null);
      return [...previous, ...mapped];
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files) {
      addFiles(event.dataTransfer.files);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
  };

  const updateInstruction = (id: string, instruction: string) => {
    const target = images.find((item) => item.id === id);
    const signature = target?.signature;

    setImages((previous) =>
      previous.map((item) => (item.id === id ? { ...item, instruction } : item))
    );

    if (signature) {
      setInstructionStore((previous) => {
        const next = { ...previous };
        if (instruction.trim()) {
          next[signature] = instruction;
        } else {
          delete next[signature];
        }
        return next;
      });
    }
  };

  const handleInstructionCopy = (image: UploadedImage) => {
    if (!image.instruction.trim()) {
      setInstructionClipboard(null);
      return;
    }

    setInstructionClipboard({ text: image.instruction, source: image.originalName });

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(image.instruction).catch(() => undefined);
    }
  };

  const handleInstructionPaste = (image: UploadedImage) => {
    if (!instructionClipboard) return;
    updateInstruction(image.id, instructionClipboard.text);
  };

  const clearInstructionClipboard = () => {
    setInstructionClipboard(null);
  };

  const handleSaveCharacter = async (image: UploadedImage) => {
    try {
      const defaultName = image.originalName.replace(/\.[^./\\]+$/, "");
      const nameInput = window.prompt("Name this character", defaultName || image.originalName);
      if (!nameInput) {
        return;
      }

      const name = nameInput.trim();
      if (!name) {
        return;
      }

      const { dataUri, contentType } = await fileToDataUri(image.file);

      setCharacters((previous) => {
        const now = Date.now();
        const existing = previous.find((entry) =>
          entry.dataUri === dataUri || entry.name.toLowerCase() === name.toLowerCase()
        );
        const others = previous.filter((entry) => entry !== existing);

        const nextCharacter: SavedCharacter = {
          id: existing?.id ?? createId(),
          name,
          dataUri,
          contentType,
          instruction: image.instruction,
          createdAt: now,
        };

        return [nextCharacter, ...others].slice(0, 60);
      });

      setStatusMessage(`Saved ${name}`);
    } catch (error) {
      console.error("Unable to save character", error);
      setErrorMessage("Unable to save character. Try again.");
    }
  };

  const handleUseCharacter = async (character: SavedCharacter) => {
    try {
      setStatusMessage(`Loading ${character.name}…`);
      const safeName = character.name.replace(/[^a-z0-9]+/gi, "_");
      const file = await dataUriToFile(
        character.dataUri,
        `${safeName || "character"}.png`,
        character.contentType
      );

      const uploaded = createUploadedImage(file, instructionStore);
      uploaded.instruction = character.instruction;

      setImages((previous) => {
        const exists = previous.some((item) => item.signature === uploaded.signature);
        if (exists) {
          return previous.map((item) =>
            item.signature === uploaded.signature
              ? { ...item, instruction: character.instruction }
              : item
          );
        }

        return [...previous, uploaded];
      });

      setInstructionStore((previous) => ({
        ...previous,
        [uploaded.signature]: character.instruction,
      }));

      setStatusMessage(`${character.name} added to references`);
    } catch (error) {
      console.error("Unable to use character", error);
      setErrorMessage("Unable to load character. Try again.");
    }
  };

  const handleDeleteCharacter = (id: string) => {
    setCharacters((previous) => previous.filter((entry) => entry.id !== id));
    setStatusMessage("Character removed");
  };

  const handleSavePrompt = () => {
    if (!prompt.trim()) {
      setErrorMessage("Enter a prompt before saving.");
      return;
    }

    const defaultName = prompt.split("\n")[0].slice(0, 40) || "Saved prompt";
    const nameInput = window.prompt("Name this prompt", defaultName);
    if (!nameInput) {
      return;
    }

    const name = nameInput.trim();
    if (!name) {
      return;
    }

    setPromptLibrary((previous) => {
      const now = Date.now();
      const filtered = previous.filter((entry) =>
        entry.name.toLowerCase() !== name.toLowerCase() && entry.prompt !== prompt
      );

      return [
        {
          id: createId(),
          name,
          prompt,
          negativePrompt,
          createdAt: now,
          updatedAt: now,
          usageCount: 0,
          thumbnail: undefined,
        },
        ...filtered,
      ].slice(0, 60);
    });

    setIsLibraryOpen(true);
    setStatusMessage(`Saved prompt: ${name}`);
  };

  const handleUseSavedPrompt = (saved: SavedPrompt) => {
    setPrompt(saved.prompt);
    setNegativePrompt(saved.negativePrompt);
    setPromptLibrary((previous) =>
      previous.map((entry) =>
        entry.id === saved.id
          ? {
              ...entry,
              usageCount: entry.usageCount + 1,
              updatedAt: Date.now(),
            }
          : entry
      )
    );
    setLastUsedPromptId(saved.id);
    setIsLibraryOpen(false);
    setStatusMessage(`Loaded prompt: ${saved.name}`);
  };

  const handleDeletePrompt = (id: string) => {
    if (id === lastUsedPromptId) {
      setLastUsedPromptId(null);
    }
    setPromptLibrary((previous) => previous.filter((entry) => entry.id !== id));
    setStatusMessage("Prompt removed");
  };

  const handleUpdatePromptThumbnail = (id: string) => {
    if (typeof window === "undefined") {
      return;
    }

    const target = promptLibrary.find((entry) => entry.id === id);
    const currentUrl = target?.thumbnail || "";
    const next = window.prompt(
      "Paste an image URL to use as the prompt thumbnail. Leave empty to remove.",
      currentUrl
    );

    if (next === null) {
      return;
    }

    const trimmed = next.trim();
    setPromptLibrary((previous) =>
      previous.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              thumbnail: trimmed.length ? trimmed : undefined,
              updatedAt: Date.now(),
            }
          : entry
      )
    );

    setStatusMessage(trimmed.length ? "Thumbnail updated" : "Thumbnail cleared");
  };

  const handleEnhancePrompt = async () => {
    if (!prompt.trim()) {
      setErrorMessage("Enter a prompt before enhancing.");
      return;
    }

    setIsEnhancingPrompt(true);
    try {
      const instructionPayload = images.map((image) => ({
        originalName: image.originalName,
        instruction: image.instruction,
      }));

      const response = await fetch(buildApiUrl("/api/enhance-prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          negativePrompt,
          instructions: instructionPayload,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        const message = payload?.error || payload?.status || "Unable to enhance prompt";
        throw new Error(message);
      }

      if (payload?.prompt) {
        setPrompt(payload.prompt);
      }
      if (typeof payload?.negativePrompt === "string") {
        setNegativePrompt(payload.negativePrompt);
      }

      setStatusMessage("Prompt enhanced");
    } catch (error) {
      console.error("Enhance prompt failed", error);
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to enhance prompt. Try again."
      );
    } finally {
      setIsEnhancingPrompt(false);
    }
  };

  const removeImage = (id: string) => {
    setImages((previous) => {
      const target = previous.find((image) => image.id === id);
      if (target) {
        URL.revokeObjectURL(target.preview);
      }
      return previous.filter((image) => image.id !== id);
    });
  };

  const importResultAsReference = async (result: GeneratedResult) => {
    try {
      setStatusMessage(`Importing from ${getProviderLabel(result.provider)}…`);

      let file: File;
      if (result.url.startsWith("data:")) {
        const match = result.url.match(/^data:([^;]+);base64,/);
        const mimeType = match?.[1] || "image/png";
        const extension = guessFileExtension(result.url, mimeType);
        const filename = `${result.provider}-output-${Date.now()}.${extension}`;
        file = await dataUriToFile(result.url, filename, mimeType);
      } else {
        const response = await fetch(result.url, { mode: "cors" });
        if (!response.ok) {
          throw new Error(`Unable to fetch generated asset (status ${response.status})`);
        }
        const blob = await response.blob();
        const mimeType = blob.type || "image/png";
        const extension = guessFileExtension(result.url, mimeType);
        const filename = `${result.provider}-output-${Date.now()}.${extension}`;
        file = new File([blob], filename, {
          type: mimeType,
          lastModified: Date.now(),
        });
      }

      const uploaded = createUploadedImage(file, instructionStore);

      setImages((previous) => {
        const exists = previous.some((item) => item.signature === uploaded.signature);
        if (exists) {
          return previous;
        }

        return [...previous, uploaded];
      });

      setStatusMessage("Image copied into references");
    } catch (error) {
      console.error("Unable to import generated image", error);
      setErrorMessage("Unable to import generated image. Try downloading manually.");
    }
  };

  const handleImportFromUrl = async () => {
    if (!importUrl.trim()) {
      setErrorMessage("Enter an image URL");
      return;
    }

    setIsImporting(true);
    try {
      const response = await fetch(buildApiUrl("/api/import-image"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl.trim() }),
      });

      const payload = await response.json();

      if (!response.ok) {
        const message = payload?.error || payload?.status || "Unable to import image";
        throw new Error(message);
      }

      const file = await dataUriToFile(payload.dataUri, payload.fileName, payload.contentType);
      const uploaded = createUploadedImage(file, instructionStore);

      setImages((previous) => {
        const exists = previous.some((item) => item.signature === uploaded.signature);
        if (exists) {
          return previous;
        }

        return [...previous, uploaded];
      });

      setImportUrl("");
      setStatusMessage("Image imported from URL");
    } catch (error) {
      console.error("Import from URL failed", error);
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to import image from URL"
      );
    } finally {
      setIsImporting(false);
    }
  };

  const runGenerationForImages = async (
    selectedImages: UploadedImage[],
    {
      promptIdForThumbnail,
      progressPrefix,
    }: { promptIdForThumbnail?: string | null; progressPrefix?: string } = {},
  ) => {
    const primaryName = selectedImages[0]?.originalName || "seedream-output";
    const baseCandidate =
      selectedImages.length === 1
        ? primaryName
        : `${primaryName.replace(/\.[^/.]+$/, "") || primaryName}-set`;
    const resultBasename = sanitizeBasename(baseCandidate);

    const instructionsPayload = selectedImages.map((image) => ({
      id: image.id,
      instruction: image.instruction,
      originalName: image.originalName,
    }));

    let sawOutputs = false;
    const completedProviders: string[] = [];
    let thumbnailCandidate: string | null = null;

    const prefix = progressPrefix ? `${progressPrefix} — ` : "";

    for (const provider of activeProviders) {
      setStatusMessage(`${prefix}Sending prompt to ${getProviderLabel(provider)}…`);

      const formData = new FormData();
      formData.append("prompt", prompt.trim());
      formData.append("provider", provider);
      if (negativePrompt.trim()) {
        formData.append("negativePrompt", negativePrompt.trim());
      }

      formData.append("instructions", JSON.stringify(instructionsPayload));
      formData.append("disableSafetyFilter", String(safetyCheckDisabled));
      formData.append("size", size);
      formData.append("aspect_ratio", aspectRatio);
      formData.append("sequential_image_generation", sequentialMode);

      if (isSequentialAuto) {
        formData.append("max_images", String(maxImages));
      }

      if (isCustomSize) {
        formData.append("width", String(customWidth));
        formData.append("height", String(customHeight));
      }

      selectedImages.forEach((image) => {
        const serverFileName = `${image.id}__${image.originalName}`;
        formData.append("images", image.file, serverFileName);
      });

      const response = await fetch(buildApiUrl("/api/generate"), {
        method: "POST",
        body: formData,
      });

      let payload: GenerationResponse | undefined;
      try {
        payload = (await response.json()) as GenerationResponse;
      } catch (error) {
        payload = undefined;
      }

      if (!response.ok) {
        const message =
          payload?.status || (payload as unknown as { error?: string })?.error || "Seedream request failed";
        throw new Error(message);
      }

      const rawOutput = payload?.output;
      const outputData = Array.isArray(rawOutput)
        ? rawOutput
        : rawOutput
        ? [rawOutput]
        : [];

      if (outputData.length) {
        const providerValue = payload?.provider || provider;
        const now = Date.now();
        const providerResults = outputData.map((url, index) => ({
          id: `${providerValue}-${resultBasename}-${now}-${index}-${Math.random().toString(16).slice(2)}`,
          url,
          provider: providerValue,
          model: payload?.model ?? null,
          basename: resultBasename,
          createdAt: now - index,
        }));

        sawOutputs = true;
        setResults((previous) => {
          const combined = [...providerResults, ...previous];
          return combined.slice(0, 60);
        });
        setLightboxIndex(0);

        if (!thumbnailCandidate && promptIdForThumbnail && providerResults[0]) {
          thumbnailCandidate = providerResults[0].url;
        }
      }

      completedProviders.push(getProviderLabel(provider));
    }

    if (completedProviders.length) {
      setStatusMessage(
        sawOutputs
          ? `${prefix}Completed: ${completedProviders.join(", ")}`
          : `${prefix}No images returned (${completedProviders.join(", ")})`,
      );
    } else {
      setStatusMessage(`${prefix}No providers completed`);
    }

    if (promptIdForThumbnail && thumbnailCandidate) {
      const capturedUrl = thumbnailCandidate;
      setPromptLibrary((previous) =>
        previous.map((entry) => {
          if (entry.id !== promptIdForThumbnail) {
            return entry;
          }

          if (entry.thumbnail === capturedUrl) {
            return entry;
          }

          return {
            ...entry,
            thumbnail: capturedUrl,
            updatedAt: Date.now(),
            usageCount: entry.usageCount > 0 ? entry.usageCount : 1,
          };
        }),
      );
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!prompt.trim()) {
      setErrorMessage("Describe the scene you want Seedream to generate.");
      return;
    }

    if (!activeProviders.length) {
      setErrorMessage("Select at least one provider.");
      return;
    }

    if (!images.length) {
      setErrorMessage("Add at least one reference image before running Seedream.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Sending your prompt…");

    try {
      await runGenerationForImages(images, { promptIdForThumbnail: lastUsedPromptId });
    } catch (error) {
      setStatusMessage("");
      setErrorMessage(
        error instanceof Error ? error.message : "Unexpected error. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
      setLastUsedPromptId(null);
    }
  };

  const handleBatchProcess = async () => {
    if (!prompt.trim()) {
      setErrorMessage("Describe the scene you want Seedream to generate.");
      return;
    }

    if (!activeProviders.length) {
      setErrorMessage("Select at least one provider.");
      return;
    }

    if (images.length < 2) {
      setErrorMessage("Add at least two reference images to run a batch.");
      return;
    }

    setIsSubmitting(true);
    setIsBatchProcessing(true);
    setErrorMessage(null);
    setBatchProgress({ completed: 0, total: images.length });
    setStatusMessage("Preparing batch…");

    let promptIdForThumbnail = lastUsedPromptId;

    try {
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const progressPrefix = `Batch ${index + 1}/${images.length}`;
        await runGenerationForImages([image], {
          promptIdForThumbnail,
          progressPrefix,
        });
        promptIdForThumbnail = null;
        setBatchProgress({ completed: index + 1, total: images.length });
      }

      setStatusMessage(`Batch complete — processed ${images.length} images.`);
    } catch (error) {
      setStatusMessage("");
      setErrorMessage(
        error instanceof Error ? error.message : "Batch halted. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
      setIsBatchProcessing(false);
      setBatchProgress({ completed: 0, total: 0 });
      setLastUsedPromptId(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Seedream Studio</h1>
        <p>
          Upload reference photos, tell Seedream what to keep from each one, and craft a
          prompt to generate your final composition.
        </p>
      </header>

      <form className="app-grid" onSubmit={handleSubmit}>
        <section className="card">
          <h2>
            <span className="tag">Step 1</span>
            Reference images
          </h2>
          <label
            className="dropzone"
            htmlFor="media-input"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            <strong>Drop images here or click to browse</strong>
            <span>
              Supports PNG, JPG or WEBP. Larger files are automatically resized and compressed
              below 10MB.
            </span>
            <input
              ref={inputRef}
              className="hidden-input"
              id="media-input"
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
            />
          </label>

          {hasImages ? (
            <div className="media-grid" aria-live="polite">
              {images.map((image, index) => (
                <article className="media-card" key={image.id}>
                  <header>
                    <span>{`Image ${index + 1}`}</span>
                    <div className="media-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleSaveCharacter(image)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="remove-button"
                        onClick={() => removeImage(image.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </header>
                  <img src={image.preview} alt={image.originalName} />
                  <textarea
                    placeholder="Tell Seedream what to borrow from this reference…"
                    value={image.instruction}
                    onChange={(event) => updateInstruction(image.id, event.target.value)}
                  />
                  <div className="instruction-actions">
                    <span>Note tools:</span>
                    <div className="instruction-buttons">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleInstructionCopy(image)}
                        disabled={!image.instruction.trim()}
                        title="Copy the guidance text from this reference"
                      >
                        Copy text
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleInstructionPaste(image)}
                        disabled={!instructionClipboard}
                        title="Paste the copied guidance text into this reference"
                      >
                        Paste text
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="helper-text">
              Reference cues can be facial features, clothing, lighting, or composition. Give each
              image a short note so Seedream knows how to blend them.
            </p>
          )}
          <div className="import-url-row">
            <input
              type="url"
              placeholder="Paste image URL to add as reference"
              value={importUrl}
              onChange={(event) => setImportUrl(event.target.value)}
            />
            <button
              type="button"
              className="ghost-button"
              onClick={handleImportFromUrl}
              disabled={isImporting}
            >
              {isImporting ? "Importing…" : "Import URL"}
            </button>
          </div>
        </section>

        {characters.length > 0 && (
          <section className="card">
            <h2>
              <span className="tag">Library</span>Saved characters
            </h2>
            <div className="character-grid">
              {characters.map((character) => (
                <article className="character-card" key={character.id}>
                  <img src={character.dataUri} alt={character.name} />
                  <div className="character-info">
                    <strong>{character.name}</strong>
                    <span>{new Date(character.createdAt).toLocaleDateString()}</span>
                    <p>{character.instruction || "No guidance saved"}</p>
                  </div>
                  <div className="character-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => handleUseCharacter(character)}
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={() => handleDeleteCharacter(character.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="card">
          <h2>
            <span className="tag">Step 2</span>
            Creative brief
          </h2>

          <div className="prompt-section">
            <label htmlFor="prompt">
              <strong>Main prompt</strong>
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the final artwork you want Seedream to create."
            />

            <label htmlFor="negative-prompt">
              <strong>Negative prompt</strong>
            </label>
            <textarea
              id="negative-prompt"
              value={negativePrompt}
              onChange={(event) => setNegativePrompt(event.target.value)}
              placeholder="Optional: list any elements Seedream should avoid."
            />
            <div className="prompt-actions">
              <button type="button" className="ghost-button" onClick={handleSavePrompt}>
                Save prompt
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setShowAdvancedPrompt(true);
                  setIsLibraryOpen(false);
                }}
              >
                Advanced prompt
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setIsLibraryOpen(true)}
              >
                {promptLibrary.length ? `Library (${promptLibrary.length})` : "Open library"}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={handleEnhancePrompt}
                disabled={isEnhancingPrompt}
              >
                {isEnhancingPrompt ? "Enhancing…" : "Enhance prompt"}
              </button>
            </div>
            <label className="safety-toggle">
              <input
                type="checkbox"
                checked={safetyCheckDisabled}
                onChange={(event) => setSafetyCheckDisabled(event.target.checked)}
              />
              <div>
                <strong>Disable safety filter</strong>
                <span>
                  Request lenient filtering, but Replicate may still block explicit sexual content.
                </span>
              </div>
            </label>

            <section className="settings-section">
              <h3>Generation settings</h3>
              <div className="settings-grid">
                <div className="settings-field">
                  <span>Providers</span>
                  <div className="provider-options">
                    {providerOptions.map((option) => {
                      const checked = activeProviders.includes(option.value);
                      return (
                        <label key={option.value} className="provider-checkbox">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              setSelectedProviders((previous) => {
                                if (event.target.checked) {
                                  return Array.from(new Set([...previous, option.value]));
                                }
                                const next = previous.filter((value) => value !== option.value);
                                return next.length ? next : ["replicate"];
                              });
                            }}
                          />
                          <span>{option.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <span className="field-hint">
                    Replicate handles full generations; Nano Banana taps Google Gemini for concept renders (references optional).
                  </span>
                </div>

                {instructionClipboard && (
                  <div className="clipboard-banner">
                    <span>Copied note from {instructionClipboard.source}</span>
                    <button type="button" onClick={clearInstructionClipboard}>
                      Clear
                    </button>
                  </div>
                )}
                <label>
                  <span>Resolution</span>
                  <select value={size} onChange={(event) => setSize(event.target.value)}>
                    {sizeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    Choose a predefined resolution or specify custom dimensions below.
                  </span>
                </label>
                <label>
                  <span>Aspect ratio</span>
                  <select
                    value={aspectRatio}
                    onChange={(event) => setAspectRatio(event.target.value)}
                  >
                    {aspectRatioOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    Match the input image or force a cinematic ratio.
                  </span>
                </label>
                <label>
                  <span>Group generation</span>
                  <select
                    value={sequentialMode}
                    onChange={(event) => {
                      const nextMode = event.target.value;
                      setSequentialMode(nextMode);
                      if (nextMode === "disabled") {
                        setMaxImages(1);
                      } else if (maxImages < 2) {
                        setMaxImages(computeDefaultMaxImages(nextMode));
                      }
                    }}
                  >
                    {sequentialModes.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    "Auto" lets Seedream produce multiple related frames when it makes sense.
                  </span>
                </label>
                <label>
                  <span>Max images</span>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={maxImages}
                    onChange={(event) => {
                      const next = Number.parseInt(event.target.value, 10);
                      if (Number.isNaN(next)) {
                        setMaxImages(1);
                        return;
                      }
                      setMaxImages(Math.min(15, Math.max(1, next)));
                    }}
                    disabled={!isSequentialAuto}
                  />
                  <span className="field-hint">
                    Up to 15 outputs when sequential mode is set to auto.
                  </span>
                </label>
                {isCustomSize && (
                  <>
                    <label>
                      <span>Width (px)</span>
                      <input
                        type="number"
                        min={1024}
                        max={4096}
                        step={64}
                        value={customWidth}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10);
                          if (Number.isNaN(next)) {
                            return;
                          }
                          setCustomWidth(
                            Math.min(4096, Math.max(1024, Math.round(next / 64) * 64))
                          );
                        }}
                      />
                      <span className="field-hint">1024 – 4096 pixels</span>
                    </label>
                    <label>
                      <span>Height (px)</span>
                      <input
                        type="number"
                        min={1024}
                        max={4096}
                        step={64}
                        value={customHeight}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10);
                          if (Number.isNaN(next)) {
                            return;
                          }
                          setCustomHeight(
                            Math.min(4096, Math.max(1024, Math.round(next / 64) * 64))
                          );
                        }}
                      />
                      <span className="field-hint">1024 – 4096 pixels</span>
                    </label>
                  </>
                )}
              </div>
            </section>
          </div>

          <div className="actions">
            <div className="status-bar" role="status" aria-live="polite">
              {errorMessage ? <span className="error-message">{errorMessage}</span> : statusMessage}
            </div>
            {images.length > 1 && (
              <button
                type="button"
                className="ghost-button"
                onClick={handleBatchProcess}
                disabled={isSubmitting || isBatchProcessing}
              >
                {isBatchProcessing
                  ? `Batching ${batchProgress.completed}/${batchProgress.total}…`
                  : `Batch process ${images.length} images`}
              </button>
            )}
            <button className="generate-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Generating…" : "Run Seedream"}
            </button>
          </div>
        </section>

        {instructionChecklist.length > 0 && (
          <section className="card">
            <h2>
              <span className="tag">Step 3</span>
              Instruction checklist
            </h2>
            <ul>
              {instructionChecklist.map(({ index: itemIndex, name, instruction }) => (
                <li key={itemIndex}>
                  <strong>{`Image ${itemIndex}`}</strong> — {name}
                  {instruction ? ` · ${instruction}` : " · No guidance added yet"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {results.length > 0 && (
          <section className="card">
            <h2>
              <span className="tag">Output</span>
              Generated media
            </h2>
            <div className="results-toolbar" aria-label="Result actions">
              <label className="results-toolbar-select">
                <input
                  type="checkbox"
                  checked={allResultsSelected}
                  onChange={handleToggleSelectAllResults}
                  disabled={!results.length}
                  aria-label={allResultsSelected ? "Clear selection" : "Select all generated media"}
                />
                <span>{allResultsSelected ? "Clear selection" : "Select all"}</span>
              </label>
              <div className="results-toolbar-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleDownloadSelectedResults}
                  disabled={!hasSelectedResults || isDownloading}
                >
                  {isDownloading ? "Downloading…" : "Download selected"}
                </button>
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={handleRemoveSelectedResults}
                  disabled={!hasSelectedResults}
                >
                  Remove selected
                </button>
              </div>
            </div>
            <div className="results-grid">
              {results.map((item, index) => {
                const lower = item.url.toLowerCase();
                const isVideo = lower.includes(".mp4") || lower.includes("video");
                const providerLabelText = getProviderLabel(item.provider);
                const label = `${providerLabelText} · Output ${index + 1}`;
                const isSelected = selectedResultIds.has(item.id);

                return (
                  <div className="generated-card" key={item.id}>
                    <div className="result-select-bar">
                      <label>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleResultSelection(item.id)}
                          aria-label={`Select ${label}`}
                        />
                        <span>Select</span>
                      </label>
                      <button
                        type="button"
                        className="ghost-button danger"
                        onClick={() => handleRemoveResult(item.id)}
                        aria-label={`Remove ${label}`}
                      >
                        Remove
                      </button>
                    </div>
                    {isVideo ? (
                      <video
                        src={item.url}
                        controls
                        autoPlay
                        loop
                        muted
                        playsInline
                        onClick={() => setLightboxIndex(index)}
                      />
                    ) : (
                      <img
                        src={item.url}
                        alt={label}
                        onClick={() => setLightboxIndex(index)}
                      />
                    )}
                    <footer>
                      <div className="result-meta">
                        <span>{providerLabelText}</span>
                        {item.model ? (
                          <span className="result-model">{item.model}</span>
                        ) : null}
                      </div>
                      <div className="result-actions">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => importResultAsReference(item)}
                        >
                          Use as reference
                        </button>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </div>
                    </footer>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </form>

      {showAdvancedPrompt && (
        <>
          <div
            className="advanced-prompt-backdrop"
            role="button"
            tabIndex={-1}
            onClick={closeAdvancedPrompt}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
                closeAdvancedPrompt();
              }
            }}
          />
          <aside
            className={`advanced-prompt-drawer ${showAdvancedPrompt ? "open" : ""}`}
            aria-hidden={!showAdvancedPrompt}
          >
            <header className="advanced-header">
              <div className="advanced-header-copy">
                <h2>Seedream Essentials</h2>
                <p>
                  A quick reference for Seedream 4’s strengths and the prompt patterns that keep multi-image runs consistent.
                </p>
              </div>
              <div className="advanced-header-meta">
                <button type="button" className="ghost-button" onClick={closeAdvancedPrompt}>
                  Close
                </button>
              </div>
            </header>

            <section className="advanced-card-grid">
              {SEEDREAM_GUIDELINES.map((section) => (
                <article key={section.title} className="advanced-card">
                  <header>
                    <div>
                      <h4>{section.title}</h4>
                      <p>{section.summary}</p>
                    </div>
                  </header>
                  <ul>
                    {section.bullets.map((bullet, index) => (
                      <li key={index}>{bullet}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>
          </aside>
        </>
      )}

      {isLibraryOpen && (
        <div
          className="prompt-library-backdrop"
          role="button"
          tabIndex={-1}
          onClick={() => setIsLibraryOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
              setIsLibraryOpen(false);
            }
          }}
        />
      )}

      <aside
        className={`prompt-library-drawer ${isLibraryOpen ? "open" : ""}`}
        aria-hidden={!isLibraryOpen}
      >
        <header className="prompt-library-header">
          <div>
            <h2>Saved prompts</h2>
            <p className="prompt-library-subtitle">
              Quickly reuse, preview, and manage your favorite prompt templates.
            </p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setIsLibraryOpen(false)}
          >
            Close
          </button>
        </header>
        <div className="prompt-library-scroll">
          {promptLibrary.length ? (
            <div className="library-card-grid">
              {promptLibrary.map((entry) => {
                const usageLabel = `${entry.usageCount} use${entry.usageCount === 1 ? "" : "s"}`;
                const thumbLabel = entry.thumbnail ? "Change thumbnail" : "Add thumbnail";

                return (
                  <article className="library-card" key={entry.id}>
                    <button
                      type="button"
                      className="library-card-thumb"
                      onClick={() => handleUpdatePromptThumbnail(entry.id)}
                    >
                      {entry.thumbnail ? (
                        <img src={entry.thumbnail} alt={`${entry.name} thumbnail`} />
                      ) : (
                        <span className="library-card-thumb-placeholder">
                          {entry.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="library-card-thumb-cta">{thumbLabel}</span>
                    </button>
                    <div className="library-card-body">
                      <div className="library-card-header">
                        <strong>{entry.name}</strong>
                        <span>{usageLabel}</span>
                      </div>
                      <p className="library-card-text">{entry.prompt}</p>
                      {entry.negativePrompt ? (
                        <p className="library-card-text negative">{entry.negativePrompt}</p>
                      ) : null}
                      <div className="library-card-meta">
                        <span>{new Date(entry.updatedAt).toLocaleString()}</span>
                      </div>
                      <div className="library-card-actions">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleUseSavedPrompt(entry)}
                        >
                          Use prompt
                        </button>
                        <button
                          type="button"
                          className="ghost-button danger"
                          onClick={() => handleDeletePrompt(entry.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="prompt-library-empty">
              <h3>No prompts saved yet</h3>
              <p>
                Craft a brief you love, tap <em>Save prompt</em>, and it will appear here with a
                preview thumbnail after you generate once.
              </p>
            </div>
          )}
        </div>
      </aside>

      {lightboxIndex !== null && results[lightboxIndex] && (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxIndex(null)}
        >
          <div className="lightbox-content" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="lightbox-close"
              onClick={() => setLightboxIndex(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="lightbox-nav lightbox-nav-prev"
              onClick={() =>
                setLightboxIndex((current) => {
                  if (current === null) return current;
                  return (current - 1 + results.length) % results.length;
                })
              }
            >
              ◀
            </button>
            <button
              type="button"
              className="lightbox-nav lightbox-nav-next"
              onClick={() =>
                setLightboxIndex((current) => {
                  if (current === null) return current;
                  return (current + 1) % results.length;
                })
              }
            >
              ▶
            </button>
            {(() => {
              const current = results[lightboxIndex];
              const lower = current.url.toLowerCase();
              const isVideo = lower.includes(".mp4") || lower.includes("video");
              const providerLabelText = getProviderLabel(current.provider);

              return (
                <>
                  <div className="lightbox-caption">
                    <span>{providerLabelText}</span>
                    {current.model ? (
                      <span className="lightbox-model">{current.model}</span>
                    ) : null}
                  </div>
                  {isVideo ? (
                    <video
                      src={current.url}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="lightbox-media"
                    />
                  ) : (
                    <img
                      src={current.url}
                      alt={`${providerLabelText} output ${lightboxIndex + 1}`}
                      className="lightbox-media"
                    />
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
