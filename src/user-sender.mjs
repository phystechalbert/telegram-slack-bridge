// This module is deliberately independent of the SDK until a send is requested.
const fail = (code) => { throw new Error(code); };
const id = (value) => {
  const n = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(n)) fail('user_sender_invalid_id');
  return n;
};

export async function stableRandomId(eventId) {
  if (typeof eventId !== 'string' || !eventId.length) fail('user_sender_event_required');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('telegram-slack-bridge:user:' + eventId)));
  return BigInt.asIntN(64, new DataView(hash.buffer).getBigUint64(0, false)).toString();
}

function verifiedUser(user, chatId) {
  if (user?._ !== 'user' || user.id !== chatId || user.bot || user.deleted || user.min || !user.accessHash || String(user.accessHash) === '0') fail('user_sender_peer_mismatch');
  return { _: 'inputPeerUser', userId: user.id, accessHash: user.accessHash };
}

function offsetPeer(peer, page) {
  if (peer?._ === 'peerUser') {
    const u = page.users?.find(u => u.id === peer.userId);
    if (u?.accessHash) return { _: 'inputPeerUser', userId: u.id, accessHash: u.accessHash };
    fail('user_sender_dialog_cursor_unavailable');
  }
  if (peer?._ === 'peerChat') return { _: 'inputPeerChat', chatId: peer.chatId };
  if (peer?._ === 'peerChannel') {
    const c = page.chats?.find(c => c.id === peer.channelId);
    if (c?.accessHash) return { _: 'inputPeerChannel', channelId: c.id, accessHash: c.accessHash };
  }
  fail('user_sender_dialog_cursor_unavailable');
}

export async function resolvePrivatePeer(client, chatId, username, accessHash) {
  chatId = id(chatId);
  let candidate;
  if (accessHash != null) {
    if (typeof accessHash !== 'string' || !/^-?[1-9]\d{0,18}$/.test(accessHash) || BigInt(accessHash) < -(1n << 63n) || BigInt(accessHash) >= (1n << 63n)) fail('user_sender_invalid_access_hash');
    candidate = { _: 'inputPeerUser', userId: chatId, accessHash: client.long(accessHash) };
  } else if (username) {
    if (typeof username !== 'string' || !/^@?[A-Za-z0-9_]{1,32}$/.test(username)) fail('user_sender_invalid_username');
    const r = await client.call({ _: 'contacts.resolveUsername', username: username.replace(/^@/, '') });
    if (r.peer?._ !== 'peerUser' || r.peer.userId !== chatId) fail('user_sender_peer_mismatch');
    candidate = verifiedUser(r.users?.find(u => u.id === chatId), chatId);
  } else {
    let cursor = { offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, excludePinned: false };
    const seen = new Set();
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await client.call({ _: 'messages.getDialogs', ...cursor, limit: 100, hash: client.zero });
      const dialogs = page.dialogs || [];
      if (dialogs.some(d => d.peer?._ === 'peerUser' && d.peer.userId === chatId)) {
        candidate = verifiedUser(page.users?.find(u => u.id === chatId), chatId);
        break;
      }
      if (!dialogs.length || page._ === 'messages.dialogs') break;
      const last = dialogs.at(-1);
      const message = page.messages?.find(m => m.id === last.topMessage && JSON.stringify(m.peerId) === JSON.stringify(last.peer));
      if (!message?.date) fail('user_sender_dialog_cursor_unavailable');
      const key = JSON.stringify([last.peer, last.topMessage]);
      if (seen.has(key)) fail('user_sender_dialog_cursor_repeated');
      seen.add(key);
      cursor = { offsetDate: message.date, offsetId: last.topMessage, offsetPeer: offsetPeer(last.peer, page), excludePinned: true };
    }
  }
  if (!candidate) fail('user_sender_peer_unavailable');
  const users = await client.call({ _: 'users.getUsers', id: [{ _: 'inputUser', userId: chatId, accessHash: candidate.accessHash }] });
  return verifiedUser(users?.find(u => u.id === chatId), chatId);
}

export function sentMessageId(result, randomId, chatId) {
  if (result?._ === 'updateShortSentMessage') return result.id;
  const updates = result?.updates || (result?.update ? [result.update] : []);
  const mapped = updates.find(u => u._ === 'updateMessageID' && String(u.randomId) === String(randomId));
  if (mapped) return mapped.id;
  const sent = updates.filter(u => u._ === 'updateNewMessage' && u.message?.out && u.message.peerId?._ === 'peerUser' && u.message.peerId.userId === chatId);
  return sent.length === 1 ? sent[0].message.id : null;
}

// Exported to permit offline verification with an SDK-shaped adapter.
export async function sendWithClient(client, { ownerId, chatId, username, accessHash, eventId, text, file = null }) {
  ownerId = id(ownerId); chatId = id(chatId);
  if (typeof text !== 'string' || (!text.trim() && !file) || text.length > (file ? 1024 : 4096)) fail('user_sender_invalid_text');
  if (file && (!(file.bytes instanceof Uint8Array) || !file.bytes.length || typeof file.name !== 'string' || !file.name.toLowerCase().endsWith('.pdf') || !/^%PDF-/.test(new TextDecoder().decode(file.bytes.subarray(0, 5))))) fail('user_sender_invalid_pdf');
  const randomId = client.long(await stableRandomId(eventId));
  const me = (await client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }))?.[0];
  if (me?._ !== 'user' || me.id !== ownerId || me.bot || me.deleted) fail('user_sender_identity_mismatch');
  const peer = await resolvePrivatePeer(client, chatId, username, accessHash);
  let request = { _: 'messages.sendMessage', peer, message: text, randomId };
  if (file) {
    const uploaded = await client.upload(file);
    request = { _: 'messages.sendMedia', peer, message: text, randomId, media: { _: 'inputMediaUploadedDocument', file: uploaded.inputFile, mimeType: 'application/pdf', attributes: [{ _: 'documentAttributeFilename', fileName: file.name }] } };
  }
  const messageId = sentMessageId(await client.call(request), randomId, chatId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) fail('user_sender_outcome_unconfirmed');
  return messageId;
}

export async function withAccount(env, ownerId, callback) {
  ownerId = id(ownerId);
  const apiId = id(env.TELEGRAM_API_ID);
  if (!/^[a-fA-F0-9]{32}$/.test(env.TELEGRAM_API_HASH || '') || typeof env.TELEGRAM_USER_SESSION !== 'string' || !env.TELEGRAM_USER_SESSION) fail('user_sender_configuration_required');
  const { createUserClient } = await import('./mtproto-transport.mjs');
  const client = await createUserClient({ apiId, apiHash: env.TELEGRAM_API_HASH, session: env.TELEGRAM_USER_SESSION });
  try {
    await verifyAccount(client, ownerId);
    return await callback(client);
  }
  finally { await client.close(); }
}

export async function verifyAccount(client, ownerId) {
  ownerId = id(ownerId);
  const me = (await client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }))?.[0];
  if (me?._ !== 'user' || me.id !== ownerId || me.bot || me.deleted) fail('user_sender_identity_mismatch');
}

export async function sendAsUser(env, job) {
  return withAccount(env, job.ownerId, client => sendWithClient(client, job));
}
