const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
const url = new URL(process.argv[2]);
if (!/^\d+:[\w-]+$/.test(token || '') || !/^[\w-]{1,256}$/.test(secret || '')
    || url.protocol !== 'https:' || url.pathname !== '/telegram' || url.search || url.hash || url.username || url.password) {
  throw Error('Expected Telegram credentials in the environment and an HTTPS /telegram URL.');
}
const base = 'https://api.telegram.org/bot' + token + '/';
async function call(method, body) {
  const response = await fetch(base + method, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw Error('Telegram rejected ' + method);
  return data.result;
}
try {
  await call('setWebhook', { url: url.href, secret_token: secret,
    allowed_updates: ['business_message', 'message', 'channel_post'], max_connections: 1 });
  if ((await call('getWebhookInfo', {})).url !== url.href) throw Error('Webhook readback failed');
  console.log('Telegram confirmed the configured webhook URL.');
} catch { console.error('Webhook setup was not confirmed.'); process.exitCode = 1; }
