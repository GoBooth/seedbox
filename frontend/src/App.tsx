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
};

type GenerationResponse = {
  output?: string[] | string;
  status?: string;
  logs?: string;
};

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [safetyCheckDisabled, setSafetyCheckDisabled] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hasImages = images.length > 0;

  useEffect(() => {
    const currentImages = images;
    return () => {
      currentImages.forEach((image) => URL.revokeObjectURL(image.preview));
    };
  }, [images]);

  const instructionChecklist = useMemo(
    () =>
      images.map((image, index) => ({
        index: index + 1,
        name: image.originalName,
        instruction: image.instruction,
      })),
    [images]
  );

  const addFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;

    setImages((previous) => {
      const deduplicated = incoming.filter((file) => {
        return !previous.some(
          (existing) =>
            existing.file.name === file.name &&
            existing.file.size === file.size &&
            existing.file.lastModified === file.lastModified
        );
      });

      const mapped = deduplicated.map((file) => ({
        id: createId(),
        file,
        originalName: file.name,
        instruction: "",
        preview: URL.createObjectURL(file),
      }));

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
    setImages((previous) =>
      previous.map((item) => (item.id === id ? { ...item, instruction } : item))
    );
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!prompt.trim()) {
      setErrorMessage("Describe the scene you want Seedream to generate.");
      return;
    }

    if (!images.length) {
      setErrorMessage("Add at least one reference image to guide the generation.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Sending your prompt to Seedream…");

    const formData = new FormData();
    formData.append("prompt", prompt.trim());
    if (negativePrompt.trim()) {
      formData.append("negativePrompt", negativePrompt.trim());
    }

    const instructionsPayload = images.map((image) => ({
      id: image.id,
      instruction: image.instruction,
      originalName: image.originalName,
    }));
    formData.append("instructions", JSON.stringify(instructionsPayload));
    formData.append("disableSafetyFilter", String(safetyCheckDisabled));

    images.forEach((image) => {
      const serverFileName = `${image.id}__${image.originalName}`;
      formData.append("images", image.file, serverFileName);
    });

    try {
      const response = await fetch(buildApiUrl("/api/generate"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let message = "Seedream request failed";
        try {
          const payload = (await response.json()) as GenerationResponse;
          message = payload?.status || (payload as unknown as { error?: string })?.error || message;
        } catch (error) {
          // Swallow JSON parse errors and use default message
        }
        throw new Error(message);
      }

      const payload = (await response.json()) as GenerationResponse;
      const outputData = Array.isArray(payload.output)
        ? payload.output
        : payload.output
        ? [payload.output]
        : [];

      setResults(outputData);
      setStatusMessage(payload.status || "Seedream finished rendering");
    } catch (error) {
      setResults([]);
      setStatusMessage("");
      setErrorMessage(
        error instanceof Error ? error.message : "Unexpected error. Please try again."
      );
    } finally {
      setIsSubmitting(false);
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
            <span>Supports PNG, JPG or WEBP up to 10MB each. You can add multiple files.</span>
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
                    <button
                      type="button"
                      className="remove-button"
                      onClick={() => removeImage(image.id)}
                    >
                      Remove
                    </button>
                  </header>
                  <img src={image.preview} alt={image.originalName} />
                  <textarea
                    placeholder="Tell Seedream what to borrow from this reference…"
                    value={image.instruction}
                    onChange={(event) => updateInstruction(image.id, event.target.value)}
                  />
                </article>
              ))}
            </div>
          ) : (
            <p className="helper-text">
              Reference cues can be facial features, clothing, lighting, or composition. Give each
              image a short note so Seedream knows how to blend them.
            </p>
          )}
        </section>

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
            <label className="safety-toggle">
              <input
                type="checkbox"
                checked={safetyCheckDisabled}
                onChange={(event) => setSafetyCheckDisabled(event.target.checked)}
              />
              <div>
                <strong>Disable safety filter</strong>
                <span>Allow NSFW generations when supported by the model.</span>
              </div>
            </label>
          </div>

          <div className="actions">
            <div className="status-bar" role="status" aria-live="polite">
              {errorMessage ? <span className="error-message">{errorMessage}</span> : statusMessage}
            </div>
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
              {instructionChecklist.map((item) => (
                <li key={item.index}>
                  <strong>{`Image ${item.index}`}</strong> — {item.name}
                  {item.instruction ? ` · ${item.instruction}` : " · No guidance added yet"}
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
            <div className="results-grid">
              {results.map((item, index) => {
                const lower = item.toLowerCase();
                const isVideo = lower.includes(".mp4") || lower.includes("video");
                const label = `Seedream output ${index + 1}`;

                return (
                  <div className="generated-card" key={item}>
                    {isVideo ? (
                      <video src={item} controls autoPlay loop muted playsInline />
                    ) : (
                      <img src={item} alt={label} />
                    )}
                    <footer>
                      <span>{label}</span>
                      <a href={item} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </footer>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </form>
    </div>
  );
}
