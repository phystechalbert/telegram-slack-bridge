import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWithClient, stableRandomId, sentMessageId, resolvePrivatePeer } from '../src/user-sender.mjs';

const user = (id, extra = {}) => ({ _: 'user', id, accessHash: '987', ...extra });
const job = { ownerId: '11', chatId: '22', username: '@example', eventId: 'job-123', text: 'Hello', file: null };
function adapter({ owner = user(11), peer = user(22), result = { _: 'updateShortSentMessage', id: 45 } } = {}) {
  const requests = [], uploads = [];
  return { requests, uploads, zero: 0, long: String, upload: async f => { uploads.push(f); return { inputFile: { _: 'inputFile', id: 'file' } }; }, call: async r => {
    requests.push(r);
    if (r._ === 'users.getUsers') return r.id[0]._ === 'inputUserSelf' ? [owner] : [peer];
    if (r._ === 'contacts.resolveUsername') return { peer: { _: 'peerUser', userId: peer.id }, users: [peer] };
    return result;
  } };
}
test('text has a stable random id, explicit peer and confirmed result', async () => {
  const c = adapter(); assert.equal(await sendWithClient(c, job), 45);
  const sent = c.requests.at(-1);
  assert.equal(sent._, 'messages.sendMessage'); assert.equal(sent.peer.userId, 22);
  assert.equal(sent.randomId, await stableRandomId(job.eventId));
  // Independently calculated using Python hashlib SHA-256 and signed big-endian first eight bytes.
  assert.equal(await stableRandomId('job-123'), '8013273496520608135');
  assert.notEqual(sent.randomId, await stableRandomId('different-job'));
});
test('owner and recipient mismatches, bots and minimal users cannot send', async () => {
  for (const config of [{ owner: user(12) }, { owner: user(11, { bot: true }) }, { peer: user(23) }, { peer: user(22, { bot: true }) }, { peer: user(22, { min: true }) }, { peer: user(22, { accessHash: '0' }) }]) {
    const c = adapter(config); await assert.rejects(sendWithClient(c, job));
    assert.ok(!c.requests.some(r => r._.startsWith('messages.send'))); assert.equal(c.uploads.length, 0);
  }
});
test('PDF upload sends a document with caption and stable request id', async () => {
  const c = adapter(), file = { bytes: new TextEncoder().encode('%PDF-1.7\n'), name: 'document.pdf' };
  assert.equal(await sendWithClient(c, { ...job, file }), 45);
  assert.equal(c.uploads[0], file); assert.equal(c.requests.at(-1).media.mimeType, 'application/pdf');
  assert.equal(c.requests.at(-1).message, 'Hello');
});
test('invalid payloads fail before account or upload calls', async () => {
  for (const patch of [{ eventId: '' }, { chatId: '-22' }, { text: '' }, { text: 'x'.repeat(4097) }, { file: { bytes: new Uint8Array([1]), name: 'bad.pdf' } }]) {
    const c = adapter(); await assert.rejects(sendWithClient(c, { ...job, ...patch })); assert.equal(c.requests.length, 0);
  }
});
test('unconfirmed send fails; matching mapping wins and wrong peer is ignored', async () => {
  await assert.rejects(sendWithClient(adapter({ result: {} }), job), /outcome_unconfirmed/);
  assert.equal(sentMessageId({ updates: [{ _: 'updateMessageID', randomId: '123', id: 98 }] }, '123', 22), 98);
  assert.equal(sentMessageId({ updates: [{ _: 'updateNewMessage', message: { out: true, id: 99, peerId: { _: 'peerUser', userId: 23 } } }] }, '123', 22), null);
});
test('numeric recipient is selected by dialog ID across pages, never display name', async () => {
  let pages = 0;
  const c = adapter();
  const original = c.call;
  c.call = async r => {
    if (r._ !== 'messages.getDialogs') return original(r);
    pages++;
    if (pages === 1) return { _: 'messages.dialogsSlice', dialogs: [{ peer: { _: 'peerUser', userId: 33 }, topMessage: 10 }], messages: [{ id: 10, date: 100, peerId: { _: 'peerUser', userId: 33 } }], users: [user(33, { bot: true })] };
    assert.equal(r.offsetId, 10); assert.equal(r.excludePinned, true);
    return { _: 'messages.dialogs', dialogs: [{ peer: { _: 'peerUser', userId: 22 } }], users: [user(22)] };
  };
  assert.equal((await resolvePrivatePeer(c, 22)).userId, 22); assert.equal(pages, 2);
});
