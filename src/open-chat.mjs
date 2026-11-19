import { withAccount, verifyAccount, resolvePrivatePeer } from './user-sender.mjs';

function targetValue(raw) {
  if (typeof raw !== 'string' || raw.length > 300 || /[\r\n\u0000-\u001f]/.test(raw)) return null;
  let value = raw.trim();
  const wrapped = /^<((?:https?:\/\/)?t\.me\/[^|>\s]+)(?:\|[^>]*)?>$/i.exec(value) || /^<tel:([^|>]+)(?:\|[^>]*)?>$/i.exec(value);
  if (wrapped) value = wrapped[1].trim();
  const link = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)\/?$/i.exec(value);
  if (link) value = '@' + link[1];
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)) return value.toLowerCase();
  if (value.startsWith('+')) {
    value = value.replace(/[ ()-]/g, '');
    return /^\+[1-9]\d{6,14}$/.test(value) ? value : null;
  }
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}

export function parseOpenChat(text) {
  if (typeof text !== 'string' || !/^!tg-chat-open(?:\s|$)/.test(text.trim())) return null;
  const target = targetValue(text.trim().slice('!tg-chat-open'.length).trim());
  return target ? { target } : { invalid: true };
}

function person(user, ownerId, expectedId) {
  if (user?._ !== 'user' || !Number.isSafeInteger(user.id) || user.id < 1 || user.id === Number(ownerId) || user.self || user.bot || user.deleted || user.min || user.scam || user.fake || !user.accessHash || String(user.accessHash) === '0' || (expectedId != null && user.id !== expectedId)) throw Error('chat_target_unavailable');
  return user;
}

async function safe(callback) {
  try { return await callback(); }
  catch (error) {
    if (/^chat_(?:open|target)_[a-z_]+$/.test(error?.message || '')) throw Error(error.message);
    if (/^(?:USERNAME_INVALID|USERNAME_NOT_OCCUPIED|PHONE_NOT_OCCUPIED)$/.test(error?.text || '')) throw Error('chat_target_not_found');
    throw Error('chat_open_unavailable');
  }
}

export async function openChatWithClient(client, { ownerId, target }) {
  return safe(async () => {
    const normalized = targetValue(target);
    if (!normalized) throw Error('chat_open_input_invalid');
    await verifyAccount(client, ownerId);
    let found;
    if (normalized.startsWith('@')) {
      const result = await client.call({ _: 'contacts.resolveUsername', username: normalized.slice(1) });
      if (result.peer?._ !== 'peerUser') throw Error('chat_target_not_a_person');
      found = person(result.users?.find(u => u.id === result.peer.userId), ownerId, result.peer.userId);
    } else if (normalized.startsWith('+')) {
      const contacts = await client.call({ _: 'contacts.getContacts', hash: client.zero });
      found = contacts.users?.find(u => u.phone === normalized.slice(1));
      if (!found) {
        const result = await client.call({ _: 'contacts.resolvePhone', phone: normalized });
        if (result.peer?._ !== 'peerUser') throw Error('chat_target_not_found');
        found = result.users?.find(u => u.id === result.peer.userId);
      }
      found = person(found, ownerId);
    } else {
      const peer = await resolvePrivatePeer(client, Number(normalized));
      found = { _: 'user', id: peer.userId, accessHash: peer.accessHash };
    }
    const users = await client.call({ _: 'users.getUsers', id: [{ _: 'inputUser', userId: found.id, accessHash: found.accessHash }] });
    const user = person(users?.find(u => u.id === found.id), ownerId, found.id);
    if (normalized.startsWith('@') && ![user.username, ...(user.usernames || []).filter(u => u.active).map(u => u.username)].some(name => typeof name === 'string' && name.toLowerCase() === normalized.slice(1))) throw Error('chat_target_mismatch');
    if (normalized.startsWith('+') && user.phone && user.phone !== normalized.slice(1)) throw Error('chat_target_mismatch');
    const label = [user.firstName, user.lastName].filter(s => typeof s === 'string' && s.trim()).join(' ') || (user.username ? '@' + user.username : String(user.id));
    return { chatId: String(user.id), username: user.username || '', label: Array.from(label.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 160).join(''), accessHash: String(user.accessHash) };
  });
}

export async function openChat(env, args) {
  return safe(() => withAccount(env, args.ownerId, client => openChatWithClient(client, args)));
}
