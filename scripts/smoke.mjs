// Exercise the built Worker, its SQLite Durable Object and alarms with local API doubles.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bindings = {
  SLACK_TEAM_ID: 'TTEST', SLACK_APP_ID: 'ATEST', SLACK_CHANNEL_ID: 'GTEST',
  SLACK_ALLOWED_USERS: 'UTEST', SLACK_BOT_TOKEN: 'local-slack', SLACK_SIGNING_SECRET: 'local-signing',
  TELEGRAM_OWNER_ID: '10', TELEGRAM_PRIVATE_CHATS: '20,21', TELEGRAM_BOT_TOKEN: '1:local',
  TELEGRAM_WEBHOOK_SECRET: 'local-webhook'
};
const posts = [], sent = [], unexpected = [];
const now = Math.floor(Date.now() / 1000);
const root = resolve('dist');
const wasm = (await readdir(root)).find(n => n.endsWith('.wasm'));
const modules = await Promise.all([['index.js', 'ESModule'], [wasm, 'CompiledWasm']].map(async ([name, type]) =>
  ({ type, path: join(root, name), contents: await readFile(join(root, name)) })));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'bridge-test', cf: false,
  modules, modulesRoot: root, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings,
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'slack.com') {
      const form = new URLSearchParams(await request.text());
      if (url.pathname === '/api/conversations.info')
        return Response.json({ ok: true, channel: { id: 'GTEST', is_member: true, is_private: true } });
      if (url.pathname === '/api/chat.postMessage') {
        const ts = now + '.' + String(posts.length + 1).padStart(6, '0');
        posts.push({ ts, thread: form.get('thread_ts'), text: form.get('text') });
        return Response.json({ ok: true, ts, channel: 'GTEST' });
      }
    }
    if (url.hostname === 'api.telegram.org') {
      const data = await request.json();
      if (url.pathname.endsWith('/getBusinessConnection'))
        return Response.json({ ok: true, result: { id: 'fixture', user: { id: 10 }, is_enabled: true, rights: { can_reply: true } } });
      if (url.pathname.endsWith('/sendMessage')) {
        sent.push(data);
        return Response.json({ ok: true, result: { chat: { id: Number(data.chat_id) }, message_id: 300,
          business_connection_id: 'fixture' } });
      }
    }
    unexpected.push(url.hostname);
    return new Response(null, { status: 501 });
  }
}));
const post = (path, body, headers) => mf.dispatchFetch('https://example.test/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
const tg = (id, chat) => ({ update_id: id, business_message: { chat: { id: chat, type: 'private', first_name: 'Test' },
  from: { id: chat, first_name: 'Test' }, date: now, message_id: id, text: 'inbound ' + chat, business_connection_id: 'fixture' } });
const telegram = (id, chat, secret = bindings.TELEGRAM_WEBHOOK_SECRET) => post('telegram', tg(id, chat), { 'x-telegram-bot-api-secret-token': secret });
const slack = (body, valid = true) => {
  const signature = createHmac('sha256', valid ? bindings.SLACK_SIGNING_SECRET : 'wrong').update('v0:' + now + ':' + JSON.stringify(body)).digest('hex');
  return post('slack', body, { 'x-slack-request-timestamp': String(now), 'x-slack-signature': 'v0=' + signature });
};
async function until(check) {
  const deadline = Date.now() + 18000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for the local relay');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
try {
  const challenge = { type: 'url_verification', challenge: 'fixture' };
  assert.equal((await slack(challenge, false)).status, 403);
  assert.deepEqual(await (await slack(challenge)).json(), { challenge: 'fixture' });
  assert.equal((await telegram(1, 20, 'wrong')).status, 403);
  assert.equal((await telegram(2, 22)).status, 200);
  for (const [id, chat] of [[3, 20], [3, 20], [4, 21]]) assert.equal((await telegram(id, chat)).status, 200);
  await until(() => posts.length >= 4);
  const thread = posts.find(p => !p.thread && p.text.includes('Chat ID: 21')).ts;
  const command = { type: 'event_callback', team_id: 'TTEST', api_app_id: 'ATEST', event_id: 'EvReply',
    event: { type: 'message', channel: 'GTEST', thread_ts: thread, ts: now + '.999999', user: 'UTEST', text: '!tg-send outbound' } };
  for (const e of [{ ...command, event_id: 'EvNo', event: { ...command.event, user: 'UOTHER' } }, command, command]) assert.equal((await slack(e)).status, 200);
  await until(() => posts.some(p => p.thread === thread && p.text.includes('Sent to Telegram')));
  assert.deepEqual(sent.map(s => [s.chat_id, s.text]), [['21', 'outbound']]);
  assert.equal(posts.length, 5);
  assert.deepEqual(unexpected, []);
  console.log('Verified signed ingress, private chat isolation, two directions, receipts and duplicate suppression.');
} finally { await mf.dispose(); }
