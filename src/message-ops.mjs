import { withAccount, verifyAccount, resolvePrivatePeer } from './user-sender.mjs';

const fail = code => { throw Error(code); };
function positiveId(value) {
  const n = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(n)) fail('tg_message_id_invalid');
  return n;
}
const inPeer = (m, chatId) => m?._ === 'message' && m.peerId?._ === 'peerUser' && m.peerId.userId === chatId;
const getMessage = async (client, messageId) => (await client.call({ _: 'messages.getMessages', id: [{ _: 'inputMessageID', id: messageId }] })).messages?.find(m => m.id === messageId);
const knownRpc = /^(?:MESSAGE_EDIT_TIME_EXPIRED|MESSAGE_NOT_MODIFIED|MESSAGE_ID_INVALID|MESSAGE_AUTHOR_REQUIRED|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID|USER_PRIVACY_RESTRICTED|YOUR_PRIVACY_RESTRICTED|MESSAGE_TOO_OLD|FLOOD_WAIT_\d+)$/;

async function safeOperation(kind, callback) {
  try { return await callback(); }
  catch (error) {
    const code = /^tg_(?:edit|read|message)_[a-z_]+$/.test(error?.message || '') ? error.message : knownRpc.test(error?.text || '') ? error.text : `tg_${kind}_failed`;
    throw Error(code);
  }
}

export async function editWithClient(client, { ownerId, chatId, username, accessHash, messageId, text }) {
  return safeOperation('edit', async () => {
    chatId = positiveId(chatId); messageId = positiveId(messageId);
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('tg_edit_text_invalid');
    await verifyAccount(client, ownerId);
    const peer = await resolvePrivatePeer(client, chatId, username, accessHash);
    const original = await getMessage(client, messageId);
    if (!inPeer(original, chatId) || !original.out || (original.fromId && (original.fromId._ !== 'peerUser' || original.fromId.userId !== Number(ownerId)))) fail('tg_edit_message_invalid');
    const media = original.media?._;
    const caption = media && !['messageMediaEmpty', 'messageMediaWebPage'].includes(media);
    if (caption && !['messageMediaPhoto', 'messageMediaDocument'].includes(media)) fail('tg_edit_not_text');
    if (caption && text.length > 1024) fail('tg_edit_caption_too_long');
    await client.call({ _: 'messages.editMessage', peer, id: messageId, message: text });
    // An RPC acknowledgement alone is insufficient: confirm the server's current text.
    const canonical = await getMessage(client, messageId);
    if (!inPeer(canonical, chatId) || !canonical.out || canonical.message !== text) fail('tg_edit_outcome_unconfirmed');
    return `Edited in Telegram · TG_MESSAGE_ID=${messageId}\n${canonical.message}`;
  });
}

export async function editMessage(env, args) {
  return safeOperation('edit', () => withAccount(env, args.ownerId, client => editWithClient(client, args)));
}

function at(date) {
  if (!Number.isSafeInteger(date) || date < 1) return 'time unavailable';
  return new Date(date * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export async function readStatusWithClient(client, { ownerId, chatId, username, accessHash }) {
  return safeOperation('read', async () => {
    chatId = positiveId(chatId);
    await verifyAccount(client, ownerId);
    const peer = await resolvePrivatePeer(client, chatId, username, accessHash);
    const result = await client.call({ _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer }] });
    const dialog = result.dialogs?.find(d => d._ === 'dialog' && d.peer?._ === 'peerUser' && d.peer.userId === chatId);
    if (!dialog || !Number.isSafeInteger(dialog.readOutboxMaxId) || dialog.readOutboxMaxId < 0) fail('tg_read_dialog_unavailable');
    const search = async fromId => (await client.call({ _: 'messages.search', peer, q: '', fromId, filter: { _: 'inputMessagesFilterEmpty' }, minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: client.zero })).messages || [];
    const outgoing = (await search({ _: 'inputPeerSelf' })).find(m => inPeer(m, chatId) && m.out);
    const incoming = (await search(peer)).find(m => inPeer(m, chatId) && !m.out);
    let status = 'No outgoing messages.';
    if (outgoing) {
      const read = outgoing.id <= dialog.readOutboxMaxId;
      let readDate = null;
      if (read) {
        try {
          const date = await client.call({ _: 'messages.getOutboxReadDate', peer, msgId: outgoing.id });
          if (date._ === 'outboxReadDate' && Number.isSafeInteger(date.date) && date.date > 0) readDate = date.date;
        } catch (error) {
          if (!/^(?:USER_PRIVACY_RESTRICTED|YOUR_PRIVACY_RESTRICTED|MESSAGE_TOO_OLD)$/.test(error?.text || '')) throw error;
        }
      }
      status = `Latest outgoing: ${outgoing.id}, sent ${at(outgoing.date)}; ${read ? `read${readDate ? ' ' + at(readDate) : ' (read time unavailable)'}` : 'not yet read'}.`;
      if (!incoming || incoming.id < outgoing.id) status += ' No incoming messages after it.';
    }
    return status + (incoming ? ` Latest incoming: ${incoming.id}, ${at(incoming.date)}.` : ' No incoming messages.');
  });
}

export async function readStatus(env, args) {
  return safeOperation('read', () => withAccount(env, args.ownerId, client => readStatusWithClient(client, args)));
}
