import test from 'node:test';
import assert from 'node:assert/strict';
import { editWithClient, readStatusWithClient } from '../src/message-ops.mjs';
import { verifyAccount } from '../src/user-sender.mjs';

const args = { ownerId: '11', chatId: '22', username: '@example', messageId: 50, text: 'Updated text' };
const message = extra => ({ _: 'message', id: 50, out: true, peerId: { _: 'peerUser', userId: 22 }, fromId: { _: 'peerUser', userId: 11 }, message: 'Original', date: 1000, ...extra });
function fixture({ original = message(), canonical, editError, ownerId = 11, read = true, readError, incoming = true } = {}) {
  const requests = []; let gets = 0;
  return { requests, zero: 0, long: String, call: async r => {
    requests.push(r);
    if (r._ === 'users.getUsers') return [{ _: 'user', id: r.id[0]._ === 'inputUserSelf' ? ownerId : 22, accessHash: '123' }];
    if (r._ === 'contacts.resolveUsername') return { peer: { _: 'peerUser', userId: 22 }, users: [{ _: 'user', id: 22, accessHash: '123' }] };
    if (r._ === 'messages.getMessages') return { messages: [gets++ === 0 ? original : canonical || message({ message: args.text })] };
    if (r._ === 'messages.editMessage') { if (editError) throw editError; return { _: 'updates', updates: [] }; }
    if (r._ === 'messages.getPeerDialogs') return { dialogs: [{ _: 'dialog', peer: { _: 'peerUser', userId: 22 }, readOutboxMaxId: read ? 50 : 49 }] };
    if (r._ === 'messages.search') return { messages: r.fromId._ === 'inputPeerSelf' ? [message()] : incoming ? [message({ id: 51, out: false, date: 1100 })] : [] };
    if (r._ === 'messages.getOutboxReadDate') { if (readError) throw readError; return { _: 'outboxReadDate', date: 1050 }; }
    throw Error('unexpected request');
  } };
}

test('edit verifies source ownership and reads canonical text after mutation', async () => {
  const c = fixture();
  assert.equal(await editWithClient(c, args), 'Edited in Telegram · TG_MESSAGE_ID=50\nUpdated text');
  assert.equal(c.requests.filter(r => r._ === 'messages.getMessages').length, 2);
  assert.ok(c.requests.findIndex(r => r._ === 'messages.editMessage') > c.requests.findIndex(r => r._ === 'messages.getMessages'));
});
test('wrong account, incoming, wrong chat, foreign sender and unsupported media cannot edit', async () => {
  for (const options of [{ ownerId: 12 }, { original: message({ out: false }) }, { original: message({ peerId: { _: 'peerUser', userId: 23 } }) }, { original: message({ fromId: { _: 'peerUser', userId: 12 } }) }, { original: message({ media: { _: 'messageMediaPoll' } }) }]) {
    const c = fixture(options); await assert.rejects(editWithClient(c, args)); assert.ok(!c.requests.some(r => r._ === 'messages.editMessage'));
  }
});
test('photo/document captions are accepted within caption limit', async () => {
  for (const type of ['messageMediaPhoto', 'messageMediaDocument']) {
    assert.match(await editWithClient(fixture({ original: message({ media: { _: type } }) }), args), /Updated text$/);
    const c = fixture({ original: message({ media: { _: type } }) });
    await assert.rejects(editWithClient(c, { ...args, text: 'x'.repeat(1025) }), /tg_edit_caption_too_long/);
    assert.ok(!c.requests.some(r => r._ === 'messages.editMessage'));
  }
});
test('invalid text and unconfirmed canonical result fail closed', async () => {
  for (const text of ['', 'x'.repeat(4001), 'hello\u0000']) await assert.rejects(editWithClient(fixture(), { ...args, text }), /tg_edit_text_invalid/);
  await assert.rejects(editWithClient(fixture({ canonical: message({ message: 'Different' }) }), args), /tg_edit_outcome_unconfirmed/);
});
test('known edit RPC errors are safe codes and arbitrary SDK errors are suppressed', async () => {
  for (const code of ['MESSAGE_EDIT_TIME_EXPIRED', 'MESSAGE_NOT_MODIFIED', 'FLOOD_WAIT_10']) await assert.rejects(editWithClient(fixture({ editError: { text: code } }), args), new RegExp(code));
  await assert.rejects(editWithClient(fixture({ editError: Error('private SDK details') }), args), /^Error: tg_edit_failed$/);
});
test('read status reports outgoing/read timestamp/incoming without marking read', async () => {
  const c = fixture(); const result = await readStatusWithClient(c, args);
  assert.match(result, /Latest outgoing: 50/); assert.match(result, /read 1970-01-01 00:17:30 UTC/); assert.match(result, /Latest incoming: 51/);
  assert.ok(!c.requests.some(r => /readHistory|readMessageContents|editMessage/.test(r._)));
});
test('unread, private read date and flood errors stay distinct', async () => {
  const unread = fixture({ read: false, incoming: false });
  assert.match(await readStatusWithClient(unread, args), /not yet read/); assert.ok(!unread.requests.some(r => r._ === 'messages.getOutboxReadDate'));
  assert.match(await readStatusWithClient(fixture({ readError: { text: 'USER_PRIVACY_RESTRICTED' } }), args), /read time unavailable/);
  await assert.rejects(readStatusWithClient(fixture({ readError: { text: 'FLOOD_WAIT_60' } }), args), /FLOOD_WAIT_60/);
});
test('account verifier rejects invalid owner before RPC', async () => {
  const c = fixture(); await assert.rejects(verifyAccount(c, '-11')); assert.equal(c.requests.length, 0);
});
test('edit and read accept bound hash without relying on a username or dialog', async () => {
  for (const operation of [editWithClient, readStatusWithClient]) {
    const c = fixture();
    await operation(c, { ...args, username: undefined, accessHash: '-123' });
    assert.ok(!c.requests.some(r => ['contacts.resolveUsername', 'messages.getDialogs'].includes(r._)));
    assert.ok(c.requests.some(r => r._ === 'users.getUsers' && r.id[0].userId === 22 && r.id[0].accessHash === '-123'));
  }
});
