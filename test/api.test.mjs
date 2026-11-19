import test from 'node:test';
import assert from 'node:assert/strict';
import {Api, ApiError} from '../src/api.mjs';
const env = {SLACK_BOT_TOKEN: 'xoxb-test-secret', TELEGRAM_BOT_TOKEN: '123:test-secret', SLACK_CHANNEL_ID: 'GABC'};
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
function fake(responses) {
  const calls = []; const http = async (url, init) => { calls.push({url, init}); const next = responses.shift(); if (next instanceof Error) throw next; assert.ok(next, 'unexpected HTTP call'); return next; };
  return {api: new Api(env, http), calls};
}
const reject = (promise, code, retry) => assert.rejects(promise, error => error instanceof ApiError && error.code === code && (retry === undefined ? error.retryAfter === undefined : error.retryAfter === retry));
test('post escapes mentions, disables parsing, checks destination and receipt', async () => {
  const {api, calls} = fake([json({ok: true, channel: 'GABC', ts: '123.456'})]);
  assert.equal(await api.post('<@U123> & <!here>', '1.2'), '123.456');
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].init.headers.authorization, 'Bearer xoxb-test-secret');
  const body = calls[0].init.body; assert.equal(body.get('text'), '&lt;@U123&gt; &amp; &lt;!here&gt;');
  for (const key of ['mrkdwn', 'link_names', 'unfurl_links', 'unfurl_media']) assert.equal(body.get(key), 'false');
  assert.equal(body.get('parse'), 'none'); assert.equal(calls[0].init.redirect, 'manual');
  await reject(fake([json({ok: true, channel: 'GOTHER', ts: '1.2'})]).api.post('hi'), 'ambiguous');
});
test('channel must be configured, private, local, active and joined', async () => {
  const good = {id: 'GABC', is_private: true, is_member: true};
  await fake([json({ok: true, channel: good})]).api.assertChannel();
  for (const bad of [{id: 'GOTHER'}, {is_private: false}, {is_member: false}, {is_shared: true}, {is_ext_shared: true}, {is_org_shared: true}, {is_archived: true}, {pending_shared: ['x']}]) {
    await reject(fake([json({ok: true, channel: {...good, ...bad}})]).api.assertChannel(), 'channel_not_private_local');
  }
});
test('business connection verifies owner, status and optional reply rights', async () => {
  const good = {id: 'business', user: {id: 42}, is_enabled: true, rights: {can_reply: true}};
  await fake([json({ok: true, result: good})]).api.assertBusiness('business', '42');
  for (const bad of [{id: 'other'}, {user: {id: 43}}, {is_enabled: false}, {rights: {can_reply: false}}]) await reject(fake([json({ok: true, result: {...good, ...bad}})]).api.assertBusiness('business', '42'), 'business_not_authorized');
  await fake([json({ok: true, result: {...good, rights: {}}})]).api.assertBusiness('business', '42', false);
});
test('transport errors are sanitized and mutations never gain unsafe retries', async () => {
  await reject(fake([new Error('secret-url-and-token')]).api.post('x'), 'ambiguous');
  await reject(fake([new Response('secret', {status: 500})]).api.post('x'), 'ambiguous');
  await reject(fake([new Response('invalid')]).api.post('x'), 'ambiguous');
  await reject(fake([new Response('', {status: 302, headers: {location: 'https://evil.test'}})]).api.post('x'), 'redirect_rejected');
  await reject(fake([new Response('{}', {status: 429, headers: {'retry-after': '7'}})]).api.post('x'), 'rate_limited', 7);
  await reject(fake([json({ok: false, error_code: 429, parameters: {retry_after: 9}})]).api.sendBot({chatId: 42}, 'x'), 'rate_limited', 9);
  await reject(fake([new Error('secret')]).api.assertChannel(), 'transport', 20);
});
test('PDF download needs authorized sharing, exact size, signature and safe host', async () => {
  const pdf = '%PDF-x';
  const file = {id: 'FABC', groups: ['GABC'], name: 'doc.pdf', size: pdf.length, mimetype: 'application/pdf', url_private: 'https://files.slack.com/files/a'};
  const {api, calls} = fake([json({ok: true, file}), new Response(pdf)]);
  assert.equal(new TextDecoder().decode((await api.getSlackPdf('FABC')).bytes), pdf);
  assert.equal(calls[1].init.headers.authorization, 'Bearer xoxb-test-secret');
  assert.equal(calls[1].init.redirect, 'manual');
  for (const bad of [{groups: ['GOTHER']}, {is_external: true}]) await reject(fake([json({ok: true, file: {...file, ...bad}})]).api.getSlackPdf('FABC'), 'file_not_in_channel');
  for (const url of ['https://evil.test/a', 'http://files.slack.com/a', 'https://files.slack.com.evil.test/a', 'https://user@files.slack.com/a']) await reject(fake([json({ok: true, file: {...file, url_private: url}})]).api.getSlackPdf('FABC'), 'unsafe_file_url');
  for (const body of ['badpdf', '%PDF-xx']) await reject(fake([json({ok: true, file}), new Response(body)]).api.getSlackPdf('FABC'), 'invalid_pdf');
  await reject(fake([json({ok: true, file: {...file, size: 5 * 1024 * 1024 + 1}})]).api.getSlackPdf('FABC'), 'invalid_pdf');
});
test('Telegram upload checks sizes, uses only intended credentials and verifies completion', async () => {
  const replies = () => [json({ok: true, result: {file_id: 'tg-file', file_size: 3, file_path: 'photos/a.jpg'}}), new Response('abc'), json({ok: true, file_id: 'FABC', upload_url: 'https://files.slack.com/upload/a'}), new Response('OK'), json({ok: true, files: [{id: 'FABC'}]})];
  const {api, calls} = fake(replies());
  await api.uploadTelegram({file_id: 'tg-file', file_size: 3, file_name: 'a.jpg'}, '1.2', '<@U>');
  assert.match(calls[1].url, /^https:\/\/api.telegram.org\/file\/bot123:test-secret\//);
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[3].init.headers.authorization, undefined);
  assert.equal(calls[4].init.body.get('channel_id'), 'GABC');
  assert.equal(calls[4].init.body.get('initial_comment'), '&lt;@U&gt;');
  const unsafe = replies(); unsafe[2] = json({ok: true, file_id: 'FABC', upload_url: 'https://evil.test/upload'});
  const unsafeFake = fake(unsafe); await reject(unsafeFake.api.uploadTelegram({file_id: 'tg-file'}, '1.2', ''), 'upload_incomplete'); assert.equal(unsafeFake.calls.length, 3);
  const incomplete = replies(); incomplete[4] = new Response('', {status: 429});
  await reject(fake(incomplete).api.uploadTelegram({file_id: 'tg-file'}, '1.2', ''), 'upload_completion_ambiguous');
  await reject(fake([]).api.uploadTelegram({file_id: 'x', file_size: 20 * 1024 * 1024 + 1}, '1.2', ''), 'invalid_telegram_file');
  await reject(fake([json({ok: true, result: {file_id: 'x', file_size: 3, file_path: '../x'}})]).api.uploadTelegram({file_id: 'x'}, '1.2', ''), 'invalid_telegram_file');
});
test('sendBot routes text and PDF without parsing, verifies positive receipt and chat', async () => {
  const {api, calls} = fake([json({ok: true, result: {message_id: 12, chat: {id: -42}, business_connection_id: 'business', message_thread_id: 7}}), json({ok: true, result: {message_id: 13, chat: {id: -42}, business_connection_id: 'business', message_thread_id: 7}})]);
  const route = {chatId: '-42', connectionId: 'business', topicId: 7};
  assert.equal(await api.sendBot(route, '<b>literal</b>'), 12);
  const body = JSON.parse(calls[0].init.body); assert.equal(body.parse_mode, undefined); assert.equal(body.business_connection_id, 'business'); assert.equal(body.message_thread_id, 7);
  assert.equal(await api.sendBot(route, 'caption', {bytes: enc('%PDF-x'), name: 'x.pdf'}), 13);
  assert.equal(calls[1].init.body.get('chat_id'), '-42'); assert.equal(calls[1].init.headers, undefined);
  for (const result of [{message_id: 0, chat: {id: 42}}, {message_id: 1, chat: {id: 43}}]) await reject(fake([json({ok: true, result})]).api.sendBot({chatId: 42}, 'x'), 'ambiguous');
});
function enc(text) { return new TextEncoder().encode(text); }
test('invalid credentials are rejected before network', async () => {
  let called = false; const api = new Api({...env, TELEGRAM_BOT_TOKEN: '123:secret/evil'}, async () => { called = true; });
  await reject(api.sendBot({chatId: 42}, 'x'), 'invalid_credentials'); assert.equal(called, false);
});
