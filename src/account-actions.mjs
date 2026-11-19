import { allowed, routeKey } from './routes.mjs';
import { contactResult, savedName } from './contacts.mjs';
import { openChat } from './open-chat.mjs';
import { editMessage, readStatus } from './message-ops.mjs';
import { sendAsUser } from './user-sender.mjs';

export function accountClient(env) {
  if (!env.TELEGRAM_USER_SESSION) return null;
  return {
    send: args => sendAsUser(env, args), contact: args => contactResult(env, args),
    savedName: args => savedName(env, args), edit: args => editMessage(env, args),
    read: args => readStatus(env, args), open: args => openChat(env, args)
  };
}

export function rootText(route, label) {
  return 'Telegram · ' + label + (route.topicId ? ' · topic ' + route.topicId : '')
    + '\nChat ID: ' + route.chatId + '\nReply here with !tg-send followed by your message.';
}

export async function accountCommand(job, c, store, api, client, now) {
  if (now - job.date > 300) return 'This command expired. Enter it again if still needed.';
  if (!client) return 'Connect the Telegram user account to use this command.';
  if (job.action === 'open') {
    if (job.user !== c.slackOwner) return;
    if (job.open.invalid) return 'Use !tg-chat-open with a username, t.me link, international phone number, or Telegram ID.';
    if (!c.connection) return 'Set TELEGRAM_BUSINESS_CONNECTION_ID to open a new conversation.';
    await api.assertBusiness(c.connection, c.owner, false);
    if (!store.claimOpen(job.id, 'lookup', 30)) return 'Daily lookup limit reached.';
    const person = await client.open({ ownerId: c.owner, target: job.open.target });
    const route = { kind: 'business', chatId: person.chatId, connectionId: c.connection, ownerId: c.owner, accessHash: person.accessHash };
    if (!allowed(route, c)) return 'This chat is outside the configured Telegram routes.';
    const key = routeKey(route);
    let thread = store.route(key)?.thread;
    if (!thread) {
      if (!store.claimOpen(job.id, 'root', 5)) return 'Daily limit for opening new threads reached.';
      thread = await store.effect('root:' + key, () => api.post(rootText(route, person.label)));
      store.remember(key, route, thread, person.username, 0);
    }
    const link = await api.slack('chat.getPermalink', { channel: c.channel, message_ts: thread });
    return 'Telegram thread: ' + link.permalink;
  }
  if (job.contact?.invalid) return 'Invalid contact command. See the README for the required fields.';
  if (job.contact?.action === 'add_phone') return client.contact({ ownerId: c.owner, request: job.contact });
  const current = store.thread(job.thread);
  const row = job.contact?.action === 'read' ? store.businessChat(job.contact.chatId, c) : current;
  if (!row) return 'No matching Telegram private chat.';
  const route = JSON.parse(row.route);
  if (route.kind !== 'business' || !allowed(route, c) || (job.contact && job.contact.chatId !== route.chatId))
    return 'This command requires the matching private chat.';
  await api.assertBusiness(route.connectionId, route.ownerId, false);
  const args = { ...route, username: row.username };
  if (job.action === 'contact') return client.contact({ ...args, request: job.contact });
  if (job.action === 'read') return client.read(args);
  if (!Number.isSafeInteger(job.messageId) || job.messageId < 1 || !job.text)
    return 'Use !tg-edit <message_id> <new text>.';
  return client.edit({ ...args, messageId: job.messageId, text: job.text });
}
