# Seedream Studio (Cloudflare + Supabase)

Seedream Studio lets you combine multiple reference images, add per-image guidance, and produce structured prompts for external providers such as Replicate’s Seedream-4 and a Gemini-powered "Nano Banana" helper. The app is built for Cloudflare Pages: a Vite + React front-end is served as static assets while Pages Functions (Workers) handle file uploads and provider calls. Every reference image is stored in Cloudflare R2 and each user’s preferences live in Supabase via email/password authentication.

> fal.ai editing is temporarily disabled in this Workers rewrite. The UI no longer shows that provider until we ship a Workers-friendly upload flow.

## Repository layout

```text
frontend/        # Vite + React (TypeScript) client
functions/       # Cloudflare Pages Functions (Workers runtime)
wrangler.toml    # Pages configuration (build command, R2 binding)
package.json     # Shared dependencies for the Workers bundle (@supabase/supabase-js)
.nvmrc           # Pins Node 20 for Wrangler and local tooling
```

## Requirements

- Node.js **20.x** (run `nvm use 20` or `volta install node@20`). Wrangler 4 refuses to run on Node 18.
- `wrangler` CLI (`npm install -g wrangler`) with `wrangler login` to authorise your Cloudflare account.
- A Cloudflare R2 bucket (default name in this repo: `seedream-uploads`).
- A Supabase project with email/password auth enabled.

## Supabase configuration

1. **API keys** – you’ll need the project URL, the public anon key, and the service-role key.
2. **Database table** – run the following SQL in the Supabase SQL editor to store per-user settings:
   ```sql
   create table if not exists public.user_settings (
     user_id uuid primary key references auth.users(id) on delete cascade,
     preferred_providers text[] not null default array['replicate'],
     size_option text not null default '2K',
     aspect_ratio text not null default 'match_input_image',
     updated_at timestamptz not null default now()
   );
   ```
3. **Redirect URLs** – add your development origin (`http://localhost:8788`) and production domain to Supabase Auth → URL Configuration.

## Environment variables

Create a `.dev.vars` file in the project root for local development:

```env
# Cloudflare / Providers
REPLICATE_API_TOKEN=sk-...
XAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ENABLE_GEMINI=true

# Supabase
SUPABASE_URL=https://rqmqkaixkrnogqcdvpiu.supabase.co
SUPABASE_ANON_KEY=ey...
SUPABASE_SERVICE_ROLE_KEY=ey...

# Front-end (exposed via Vite)
VITE_SUPABASE_URL=https://rqmqkaixkrnogqcdvpiu.supabase.co
VITE_SUPABASE_ANON_KEY=ey...
```

> The build script automatically stamps each build with `0.<commit-count>-<short-sha>` and passes it to Vite as `VITE_BUILD_VERSION`, so you don't need to set it manually.

In Cloudflare Pages add the same variables (use **Secrets** for sensitive values like `SUPABASE_SERVICE_ROLE_KEY`, `REPLICATE_API_TOKEN`, and `XAI_API_KEY`). Make sure the R2 binding is called **`UPLOADS_BUCKET`** to match the Worker code.

## Local development

1. Install dependencies:
   ```bash
   npm install          # installs Workers dependencies (@supabase/supabase-js)
   npm install --prefix frontend
   ```

2. Run the full stack with Wrangler (serves the built client + functions):
   ```bash
   wrangler pages dev
   ```
   Wrangler runs the build command defined in `wrangler.toml` (`npm run build:frontend`) and mounts the functions in `functions/` on <http://127.0.0.1:8788>.

3. Optional – run Vite with hot module replacement in a second terminal and point API calls back to Wrangler:
   ```bash
   npm run dev --prefix frontend
   # frontend/.env
   VITE_API_BASE_URL=http://127.0.0.1:8788
   ```

Uploads larger than 10 MB are rejected in the browser before they reach the Worker. Accepted files are saved to R2 under `users/<supabase-user-id>/uploads/...` (remote imports go to `users/<id>/remote/...`).

## Deployment

1. Push the repository to GitHub and connect it to a Cloudflare Pages project.
2. In the Pages build settings set:
   - **Build command**: `npm run build:frontend`
   - **Build output directory**: `frontend/dist`
   - **Functions directory**: `functions`
   > The build script computes a monotonically increasing version (`0.<commit-count>-<short-sha>`) and exposes it to Vite as `VITE_BUILD_VERSION` before bundling.
3. In Pages → Settings → Environment variables add the same variables you defined in `.dev.vars` (Production and Preview). Include both the Workers secrets (`SUPABASE_SERVICE_ROLE_KEY`, `REPLICATE_API_TOKEN`, etc.) and the Vite build variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
4. In the same settings screen add the R2 binding: name **`UPLOADS_BUCKET`** and point it at your bucket (e.g., `seedream-uploads`).
5. Push commits to the tracked branch (`git push`). Pages will rebuild automatically and deploy the new static assets + Workers bundle.

You can also deploy directly from the CLI with `wrangler pages deploy frontend` once your account and project are configured.

## Runtime endpoints

All API routes require a valid Supabase access token (the React app attaches it automatically once the user signs in).

| Route | Method | Description |
| --- | --- | --- |
| `/api/generate` | POST | Upload references, merge guidance, and trigger Replicate or Nano Banana generations. |
| `/api/enhance-prompt` | POST | Expand prompts via xAI Grok. |
| `/api/advanced-suggestions` | POST | Grok-powered placeholder suggestions for advanced cards. |
| `/api/advanced-blueprints` | POST | Grok-generated prompt blueprints (recommended + alternatives). |
| `/api/import-image` | POST | Fetch remote image URLs, validate, and store in R2. |
| `/api/demo-run` | POST | Minimal Seedream-4 run using the stored references. |
| `/api/settings` | GET/PUT | Load and persist per-user settings in Supabase. |
| `/api/health` | GET | Simple health check exposing the configured Seedream version. |

## Front-end behaviour

- Users must create an account (Supabase email/password) to access the app. Sign-ups trigger the default Supabase email confirmation flow.
- Provider selection, default resolution, and aspect ratio sync automatically to Supabase. A “saving…” message appears in the header while updates are in flight.
- All existing client-side features (drag-and-drop references, saved prompts/characters, advanced prompt composer) continue to work locally and in production.

## Troubleshooting

- **401 / "Unauthorized"** – ensure the front-end request includes the `Authorization` header. This happens automatically after signing in; if you see it repeatedly, confirm the Supabase service role key is set for the Worker.
- **Supabase table errors** – the API expects the `user_settings` table described above. Create it manually if you skipped that step.
- **Uploads failing** – verify the R2 binding is named `UPLOADS_BUCKET` and the Cloudflare Pages environment has permission to write to the chosen bucket.

Have fun remixing Seedream prompts! Pull requests are welcome—especially to bring back fal.ai editing support or expand per-user settings.
