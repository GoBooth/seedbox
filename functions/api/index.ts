// functions/api/index.ts
import { Hono } from 'hono';

export interface Env {
  UPLOADS_BUCKET: R2Bucket;   // <-- matches your Cloudflare binding name
  GEMINI_API_KEY: string;
  ENABLE_GEMINI: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

// Upload: multipart/form-data with field "file" (and optional "key")
app.post('/upload', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'file missing' }, 400);

  const key = (form.get('key')?.toString() || `${Date.now()}-${file.name}`).replace(/\s+/g, '_');

  await c.env.UPLOADS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: (file as File).type || 'application/octet-stream' },
  });

  return c.json({ key });
});

// Download: streams object (private bucket; served via function)
app.get('/download/:key', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.UPLOADS_BUCKET.get(key);
  if (!obj) return c.notFound();

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  return new Response(obj.body, { headers });
});

// Gemini proxy (text example). Extend for image gen as needed.
app.post('/gemini/generate', async (c) => {
  if (c.env.ENABLE_GEMINI !== 'true') return c.json({ error: 'Gemini disabled' }, 400);

  const body = await c.req.json<{ model?: string; contents: any }>();
  const model = body.model || 'gemini-1.5-flash';

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${c.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: body.contents }),
    }
  );

  const data = await resp.json();
  return c.json(data, resp.ok ? 200 : 500);
});

export const onRequest = app.fetch;
