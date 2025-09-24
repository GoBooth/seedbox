# Seedream Studio

A modern web experience for orchestrating multi-reference prompts with [Seedream-4](https://replicate.com/bytedance/seedream-4) on Replicate. The project is split into a Vite + React front-end and an Express-based API proxy that safely forwards uploads to Replicate.

## Features

- **Drag-and-drop gallery** – upload multiple reference images, preview them instantly, and remove any you no longer need.
- **Per-image guidance** – add a short instruction for every image so Seedream-4 knows exactly what to extract.
- **Creative brief composer** – craft a primary prompt and optional negative prompt inside an elegant, distraction-free workspace.
- **Safety override** – optionally disable Seedream’s NSFW filter before sending a run when you need unrestricted generations.
- **Result viewer** – display generated images or videos, with quick links to open the assets in a new tab.
- **Secure Replicate bridge** – the back-end accepts files via `multipart/form-data`, converts them to data URIs, and forwards them using Replicate’s official SDK.

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
   - `SEEDREAM4_MODEL_VERSION` – the fully-qualified model version string (for example, `bytedance/seedream-4:<hash>`).

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

   The front-end proxies `/api` requests to `http://localhost:5000` by default. Set `VITE_API_BASE_URL` in `frontend/.env` if you deploy the back-end elsewhere.

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
