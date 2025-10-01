# Seedream Studio

A modern web experience for orchestrating multi-reference prompts with [Seedream-4](https://replicate.com/bytedance/seedream-4) on Replicate. The project is split into a Vite + React front-end and an Express-based API proxy that safely forwards uploads to Replicate.

## Features

- **Drag-and-drop gallery** – upload multiple reference images, preview them instantly, and remove any you no longer need.
- **Per-image guidance** – add a short instruction for every image so Seedream-4 knows exactly what to extract.
- **Generation controls** – tweak resolution, aspect ratio, and sequential output directly from the UI.
- **Instruction clipboard** – copy/paste per-image guidance between references and keep notes synced locally.
- **Remote import** – paste a hosted image URL to pull it straight into the reference panel.
- **Character library** – name and store frequently used references for one-click reuse.
- **Provider switcher** – run the same prompt through Replicate’s Seedream-4 and fal.ai’s Seedream Edit for quick side-by-side comparisons.
- **Advanced fal.ai controls** – supply a deterministic seed and toggle synchronous delivery when calling Seedream Edit.
- **Creative brief composer** – craft a primary prompt and optional negative prompt inside an elegant, distraction-free workspace.
- **Safety override** – optionally disable Seedream’s NSFW filter before sending a run when you need unrestricted generations.
- **Result viewer** – display generated images or videos, with quick links to open the assets in a new tab.
- **Secure Replicate bridge** – the back-end accepts files via `multipart/form-data`, converts them to data URIs, and forwards them using Replicate’s official SDK.
- **One-click demo** – visit `http://localhost:5001/demo` to try a minimal prompt runner that mirrors Replicate’s quickstart example.

## Project structure

```text
frontend/   # Vite + React (TypeScript) client
server/     # Express API proxy with Replicate integration
```

## Getting started

1. **Install dependencies**

   ```bash
   cd frontend && npm install
   cd ../server && npm install
   ```

   > ℹ️  If you encounter registry access restrictions, configure `npm` to use a mirror or install the listed packages manually.

2. **Configure environment variables**

   Copy the server example file and fill in your credentials:

   ```bash
   cd server
   cp .env.example .env
   ```

   Required values:

   - `REPLICATE_API_TOKEN` – your Replicate API token.
   - `XAI_API_KEY` – your xAI (Grok) API key used for prompt enhancement.
   - `SEEDREAM4_MODEL_VERSION` – optional override for the model version. You can supply a version hash (`bytedance/seedream-4:<hash>`) or rely on the default slug `bytedance/seedream-4` to use the latest release.
   - `FAL_KEY` – optional fal.ai API key (required only if you switch the provider to fal.ai).
   - `FAL_MODEL` – optional fal.ai model identifier (defaults to `fal-ai/bytedance/seedream/v4/edit`).

3. **Run the development servers**

   Start the API proxy:

   ```bash
   cd server
   npm run dev
   ```

   In a second terminal, start the Vite dev server:

   ```bash
   cd frontend
   npm run dev
   ```

   The front-end proxies `/api` requests to `http://localhost:5001` by default. Set `VITE_API_BASE_URL` in `frontend/.env` if you deploy the back-end elsewhere.

   > ✅  Select one or more providers in the "Generation settings" panel to compare outputs from Replicate and fal.ai with the same prompt.

   > ✅  Want to sanity-check your Replicate token? With the server running, open `http://localhost:5001/demo` for a lightweight UI that posts the quickstart prompt straight to the API.

4. **Production build**

   ```bash
   cd frontend
   npm run build
   ```

   The compiled assets land in `frontend/dist/`.

## API request flow

1. The React app collects your prompt, negative prompt, and per-image instructions.
2. Files are sent to the Express server with names encoded as `<uuid>__<original-name>`.
3. The server converts each image to a `data:` URI, merges your instructions into a structured prompt, and calls Replicate via `replicate.run()`.
4. Replicate responds with an array of URLs (images or videos) that the front-end displays immediately.

## Notes

- Increase the `multer` limits in `server/index.js` if you need to accept more or larger files.
- Update `vite.config.ts` proxy settings if your API runs on a different port.
- Customize the UI theme by editing `frontend/src/App.css`.
- Fine-tune Seedream requests from the UI—resolution, aspect ratio, sequential mode, and maximum outputs map directly to the Replicate options.
- Tick one or both providers in the UI (Replicate, fal.ai); populate `FAL_KEY` (and optionally `FAL_MODEL`) before enabling fal.ai.
- The instruction clipboard stores per-image notes locally so you can reuse guidance across uploads.
- Import remote images via the URL field in Step 1; the server fetches them and enforces the 10MB limit.
- The server normalises reference images to `MAX_IMAGE_DIMENSION` (default 2048px) so Seedream always receives compatible sizes.
- Saved characters let you name references for reuse; they live in your browser storage and can be reinserted with one click.
