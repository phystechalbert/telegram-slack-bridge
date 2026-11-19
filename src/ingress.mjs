import { config, slackJob, telegramJob } from './routes.mjs';

const encoder = new TextEncoder();
async function authenticatedSlack(request, raw, secret, now) {
  const stamp = request.headers.get('x-slack-request-timestamp') || '';
  const sig = request.headers.get('x-slack-signature') || '';
  if (!/^\d{10}$/.test(stamp) || Math.abs(now - Number(stamp)) > 300 || !/^v0=[0-9a-f]{64}$/.test(sig)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(sig.slice(3).match(/../g), h => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode('v0:' + stamp + ':' + raw));
}

async function authenticatedTelegram(supplied, expected) {
  if (!supplied || supplied.length > 256) return false;
  const hash = s => crypto.subtle.digest('SHA-256', encoder.encode(s));
  const [a, b] = await Promise.all([hash(supplied), hash(expected)]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

async function readBody(request) {
  const max = 256 * 1024;
  if (+request.headers.get('content-length') > max) throw Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    if ((size += value.byteLength) > max) { await reader.cancel(); throw Error('too_large'); }
    text += decoder.decode(value, { stream: true });
  }
}

export async function ingress(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/telegram', '/slack'].includes(path)) return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let c;
  try { c = config(env); } catch { return new Response('Configuration incomplete', { status: 503 }); }
  const now = Math.floor(Date.now() / 1000);
  if (path === '/telegram' && !await authenticatedTelegram(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET))
    return new Response(null, { status: 403 });
  let raw, body;
  try {
    raw = await readBody(request);
    if (path === '/slack' && !await authenticatedSlack(request, raw, env.SLACK_SIGNING_SECRET, now))
      return new Response(null, { status: 403 });
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object') throw Error('invalid_body');
  } catch (error) { return new Response(null, { status: error.message === 'too_large' ? 413 : 400 }); }
  if (path === '/slack' && body.type === 'url_verification' && typeof body.challenge === 'string')
    return Response.json({ challenge: body.challenge });
  const job = path === '/slack' ? slackJob(body, env, c, now) : telegramJob(body, c, now);
  if (!job) return new Response(null, { status: 200 });
  const id = env.RELAY.idFromName(c.installation);
  return env.RELAY.get(id).fetch('https://relay.internal/enqueue', {
    method: 'POST', body: JSON.stringify({ installation: c.installation, job })
  });
}
