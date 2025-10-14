type SeedboxConfig = {
  url?: string;
  anonKey?: string;
};

const injectSupabaseConfig = (html: string, config: SeedboxConfig) => {
  const serialized = JSON.stringify({
    url: config.url ?? null,
    anonKey: config.anonKey ?? null,
  });
  const marker = '</head>';
  if (!html.includes(marker)) {
    return `${html}<script>self.__SEEDBOX_SUPABASE__=${serialized};</script>`;
  }
  return html.replace(
    marker,
    `<script>self.__SEEDBOX_SUPABASE__=${serialized};</script>${marker}`,
  );
};

export const onRequest = async ({ request, next, env }) => {
  if (request.method === 'OPTIONS') {
    const h = new Headers();
    h.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
    h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return new Response(null, { status: 204, headers: h });
  }
  const resp = await next();
  const origin = request.headers.get('Origin') || '*';
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');

  const contentType = headers.get('Content-Type') || headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const html = await resp.text();
    const config: SeedboxConfig = {
      url: env.VITE_SUPABASE_URL || env.SUPABASE_URL || null,
      anonKey: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || null,
    };
    const populatedHtml = injectSupabaseConfig(html, config);
    return new Response(populatedHtml, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
};
