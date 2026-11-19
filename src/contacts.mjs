import {withAccount, resolvePrivatePeer} from './user-sender.mjs';
const fail = code => { throw new Error(code); };
const validId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const nameOk = (value, empty = false) => typeof value === 'string' && value.length <= 64 && value.trim() === value && (empty || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value);
const expectedOk = (value, empty = false) => typeof value === 'string' && value.length <= 512 && (empty || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value);
function validate(request) {
  if (!request || !['read','create','rename','add_phone'].includes(request.action)) fail('contact_input_invalid');
  if (request.action !== 'add_phone' && !validId(request.chatId)) fail('contact_input_invalid');
  if (request.action === 'read') return request;
  if (!nameOk(request.firstName) || !nameOk(request.lastName, true)) fail('contact_name_invalid');
  if (request.action === 'create' && request.expectedUsername !== undefined && request.expectedUsername !== '' && (typeof request.expectedUsername !== 'string' || !/^@?[A-Za-z0-9_]{5,32}$/.test(request.expectedUsername))) fail('contact_input_invalid');
  if (request.action === 'rename' && (!expectedOk(request.expectedFirstName) || !expectedOk(request.expectedLastName, true))) fail('contact_input_invalid');
  if (request.action === 'add_phone' && (typeof request.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(request.phone))) fail('contact_phone_input_invalid');
  return request;
}
export function parseContactCommand(text) {
  if (typeof text !== 'string' || !/^!tg-contact-(?:read|add|rename|add-phone)(?:\s|$)/.test(text)) return null;
  try {
    const match = /^!tg-contact-(read|add|rename|add-phone)(?: (.*))?$/su.exec(text); if (!match) fail('contact_input_invalid');
    const [, command, rest = ''] = match; let request;
    if (command === 'read') request = {action: 'read', chatId: rest};
    else if (command === 'add-phone') {
      const value = rest.replace(/<tel:([^|>]+)(?:\|[^>]*)?>/g, (_, n) => n); let p;
      if (value.startsWith('{')) { p = JSON.parse(value); if (!p || Array.isArray(p) || Object.keys(p).some(k => !['phone','first_name','last_name'].includes(k))) fail('contact_input_invalid'); }
      else { const m = /^(\+[0-9()-]+)\s+(.+)$/su.exec(value); if (!m) fail('contact_input_invalid'); p = {phone: m[1], first_name: m[2].trim()}; }
      request = {action: 'add_phone', phone: typeof p.phone === 'string' ? p.phone.replace(/[\s()-]/g, '') : p.phone, firstName: p.first_name, lastName: p.last_name ?? ''};
    } else {
      const p = JSON.parse(rest); const keys = command === 'add' ? ['chat_id','first_name','last_name','expected_username'] : ['chat_id','first_name','last_name','expected_first_name','expected_last_name'];
      if (!p || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) fail('contact_input_invalid');
      request = {action: command === 'add' ? 'create' : 'rename', chatId: p.chat_id, firstName: p.first_name, lastName: p.last_name ?? '', ...(command === 'add' ? {expectedUsername: p.expected_username} : {expectedFirstName: p.expected_first_name, expectedLastName: p.expected_last_name})};
    }
    return validate(request);
  } catch { return {invalid: true}; }
}
function checkedUser(user, target) {
  if (user?._ !== 'user' || String(user.id) !== String(target) || user.bot || user.deleted || user.min || !user.accessHash || String(user.accessHash) === '0') fail('contact_identity_unavailable');
  return user;
}
function view(user) {
  return {chat_id: String(user.id), is_contact: user.contact === true, account_name: {first_name: user.firstName || '', last_name: user.lastName || ''}, saved_name: user.contact === true && !!user.firstName ? {first_name: user.firstName, last_name: user.lastName || ''} : null, username: user.username || ''};
}
async function read(client, peer) {
  const users = await client.call({_: 'users.getUsers', id: [{_: 'inputUser', userId: peer.userId, accessHash: peer.accessHash}]});
  const user = checkedUser(users?.find(u => String(u.id) === String(peer.userId)), peer.userId);
  return {user, view: view(user)};
}
const matches = (name, first, last) => name?.first_name === first && name?.last_name === last;
const usernameMatches = (user, expected) => (user.username || '').toLowerCase() === (expected || '').replace(/^@/, '').toLowerCase();
function assertBefore(request, current) {
  if (request.action === 'create') {
    if (current.user.contact === true) fail('contact_already_saved');
    if (!usernameMatches(current.user, request.expectedUsername)) fail('contact_username_changed_since_read');
  } else if (request.action === 'rename') {
    if (!current.view.saved_name) fail('contact_saved_name_unavailable');
    if (!matches(current.view.saved_name, request.expectedFirstName, request.expectedLastName)) fail('contact_name_changed_since_read');
  }
}
// Exported solely to exercise the same operations with an offline SDK-shaped adapter.
export async function contactWithClient(client, {ownerId, chatId, username, accessHash, request}) {
  validate(request);
  if (!validId(String(ownerId))) fail('contact_owner_invalid');
  let peer; let writing = false;
  try {
    if (request.action === 'add_phone') {
      // Never blindly import: a hidden saved contact could otherwise be renamed.
      let resolved;
      try { resolved = await client.call({_: 'contacts.resolvePhone', phone: request.phone.slice(1)}); } catch { fail('contact_phone_verification_required'); }
      if (resolved?.peer?._ !== 'peerUser') fail('contact_phone_verification_required');
      const target = resolved.peer.userId;
      const user = checkedUser(resolved.users?.find(u => String(u.id) === String(target)), target);
      if (String(target) === String(ownerId)) fail('contact_phone_is_owner');
      peer = {_: 'inputPeerUser', userId: target, accessHash: user.accessHash};
      const before = await read(client, peer);
      if (before.user.contact === true) return {ok: true, action: request.action, status: 'already_saved', contact: before.view};
      const fresh = await read(client, peer);
      if (fresh.user.contact === true) return {ok: true, action: request.action, status: 'already_saved', contact: fresh.view};
      // Add the verified exact peer rather than importing the number. A number
      // resolving differently later cannot cause a different contact to be renamed.
      writing = true;
      const result = await client.call({_: 'contacts.addContact', id: {_: 'inputUser', userId: peer.userId, accessHash: peer.accessHash}, firstName: request.firstName, lastName: request.lastName, phone: '', addPhonePrivacyException: false});
      if (!result || !['updates','updatesCombined','updateShort'].includes(result._)) fail('contact_readback_unconfirmed');
    } else {
      if (!validId(String(chatId)) || request.chatId !== String(chatId) || String(chatId) === String(ownerId)) fail('contact_target_mismatch');
      peer = await resolvePrivatePeer(client, Number(chatId), username, accessHash);
      if (peer?._ !== 'inputPeerUser' || String(peer.userId) !== request.chatId) fail('contact_target_mismatch');
      const before = await read(client, peer);
      if (request.action === 'read') return {ok: true, action: 'read', contact: before.view};
      assertBefore(request, before);
      if (request.action === 'rename' && matches(before.view.saved_name, request.firstName, request.lastName)) return {ok: true, action: 'rename', status: 'already_matches', contact: before.view};
      const fresh = await read(client, peer); assertBefore(request, fresh);
      writing = true;
      const result = await client.call({_: 'contacts.addContact', id: {_: 'inputUser', userId: peer.userId, accessHash: peer.accessHash}, firstName: request.firstName, lastName: request.lastName, phone: request.action === 'rename' ? fresh.user.phone || '' : '', addPhonePrivacyException: false});
      if (!result || !['updates','updatesCombined','updateShort'].includes(result._)) fail('contact_readback_unconfirmed');
    }
    const after = await read(client, peer);
    if (!after.view.saved_name || !matches(after.view.saved_name, request.firstName, request.lastName) || (request.action === 'create' && !usernameMatches(after.user, request.expectedUsername))) fail('contact_readback_unconfirmed');
    return {ok: true, action: request.action, status: 'verified', contact: after.view};
  } catch (error) {
    if (writing) fail('contact_outcome_unconfirmed');
    throw error;
  }
}
const safeError = error => /^contact_[a-z_]+$/.test(error?.message || '') ? error.message : 'contact_unavailable';
export async function contactResult(env, args) {
  try {
    validate(args.request);
    return JSON.stringify(await withAccount(env, args.ownerId, client => contactWithClient(client, args)));
  } catch (error) { return JSON.stringify({ok: false, error: safeError(error)}); }
}
export async function savedName(env, {ownerId, chatId, username, accessHash}) {
  try {
    const result = await withAccount(env, ownerId, client => contactWithClient(client, {ownerId, chatId, username, accessHash, request: {action: 'read', chatId: String(chatId)}}));
    const name = result.contact.saved_name;
    return name ? [name.first_name, name.last_name].filter(Boolean).join(' ') : '';
  } catch { return ''; }
}
