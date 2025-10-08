export const onRequest = async ({ request, next }) => {
  if (request.method === 'OPTIONS') {
    const h = new Headers();
    h.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
    h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return new Response(null, { status: 204, headers: h });
  }
  const resp = await next();
  const origin = request.headers.get('Origin') || '*';
  resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Vary', 'Origin');
  return resp;
};
