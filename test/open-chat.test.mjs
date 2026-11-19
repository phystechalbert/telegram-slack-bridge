import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenChat, openChatWithClient } from '../src/open-chat.mjs';
import { sendWithClient, resolvePrivatePeer } from '../src/user-sender.mjs';

const user = extra => ({ _: 'user', id: 22, accessHash: '-123', username: 'example', firstName: 'Example', ...extra });
function fixture({ found = user(), canonical = found, owner = 11, saved = false } = {}) {
  const calls = [];
  return { calls, zero: '0', long: String, call: async r => {
    calls.push(r);
    if (r._ === 'users.getUsers') return r.id[0]._ === 'inputUserSelf' ? [{ _: 'user', id: owner }] : [canonical];
    if (r._ === 'contacts.resolveUsername' || r._ === 'contacts.resolvePhone') return { peer: { _: 'peerUser', userId: found.id }, users: [found] };
    if (r._ === 'contacts.getContacts') return { _: 'contacts.contacts', users: saved ? [found] : [] };
    if (r._ === 'messages.getDialogs') return { _: 'messages.dialogs', dialogs: [{ peer: { _: 'peerUser', userId: 22 } }], users: [found] };
    if (r._ === 'messages.sendMessage') return { _: 'updateShortSentMessage', id: 90 };
    throw Error('unexpected call');
  } };
}

test('parser accepts one username/link/phone/id and normalizes Slack wrappers', () => {
  for (const [input, target] of [
    ['@Example', '@example'], ['https://t.me/Example', '@example'],
    ['<https://t.me/Example|Example>', '@example'], ['t.me/example/', '@example'],
    ['+1 (202) 555-0123', '+12025550123'], ['<tel:+12025550123|phone>', '+12025550123'], ['22', '22'],
  ]) assert.deepEqual(parseOpenChat('!tg-chat-open ' + input), { target });
  assert.equal(parseOpenChat('ordinary message'), null);
  assert.equal(parseOpenChat('!tg-chat-openish @example'), null);
  for (const input of ['', 'name only', '@example extra', 'https://t.me/example/123', 'https://evil.test/example', '-22', '0', '9007199254740992', '+12025550123\nextra']) assert.deepEqual(parseOpenChat('!tg-chat-open ' + input), { invalid: true });
});
test('username lookup returns canonical verified peer without a mutation', async () => {
  const c = fixture();
  assert.deepEqual(await openChatWithClient(c, { ownerId: '11', target: '@Example' }), { chatId: '22', username: 'example', label: 'Example', accessHash: '-123' });
  assert.ok(c.calls.every(r => ['users.getUsers', 'contacts.resolveUsername'].includes(r._)));
});
test('phone lookup uses visible saved phone or read-only resolution', async () => {
  for (const saved of [true, false]) {
    const c = fixture({ found: user({ phone: '12025550123', username: undefined }), saved });
    assert.equal((await openChatWithClient(c, { ownerId: 11, target: '+12025550123' })).chatId, '22');
    assert.equal(c.calls.some(r => r._ === 'contacts.resolvePhone'), !saved);
    assert.ok(!c.calls.some(r => /importContacts|addContact|send/.test(r._)));
  }
});
test('numeric target is matched against dialogs and read back', async () => {
  const c = fixture(); assert.equal((await openChatWithClient(c, { ownerId: 11, target: '22' })).chatId, '22');
  assert.ok(c.calls.some(r => r._ === 'messages.getDialogs'));
});
test('wrong owner, self, bot, deleted/minimal/flagged users and readback changes fail closed', async () => {
  for (const config of [{ owner: 12 }, { found: user({ id: 11 }) }, { found: user({ bot: true }) }, { found: user({ deleted: true }) }, { found: user({ min: true }) }, { found: user({ scam: true }) }, { found: user({ accessHash: '0' }) }, { canonical: user({ id: 23 }) }, { canonical: user({ username: 'different' }) }]) {
    await assert.rejects(openChatWithClient(fixture(config), { ownerId: 11, target: '@example' }));
  }
});
test('stored peer hash bypasses username/dialog lookup but always reads exact ID', async () => {
  const c = fixture({ canonical: user({ username: undefined }) });
  const peer = await resolvePrivatePeer(c, 22, undefined, '-123');
  assert.equal(peer.userId, 22); assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].id[0].accessHash, '-123');
  const result = await sendWithClient(c, { ownerId: 11, chatId: 22, accessHash: '-123', eventId: 'bound-job', text: 'Hello' });
  assert.equal(result, 90);
  assert.ok(!c.calls.some(r => r._ === 'messages.getDialogs' || r._ === 'contacts.resolveUsername'));
  await assert.rejects(resolvePrivatePeer(fixture({ canonical: user({ id: 23 }) }), 22, undefined, '-123'));
});
test('invalid or out-of-range persisted hashes cannot become a peer', async () => {
  for (const hash of ['', '0', '-0', 'not-a-hash', '9223372036854775808', '-9223372036854775809']) {
    const c = fixture(); await assert.rejects(resolvePrivatePeer(c, 22, undefined, hash)); assert.equal(c.calls.length, 0);
  }
});
