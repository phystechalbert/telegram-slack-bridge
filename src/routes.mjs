import { parseContactCommand } from './contacts.mjs';
import { parseSchedule } from './schedule.mjs';
import { parseOpenChat } from './open-chat.mjs';

const slackUser = /^[UW][A-Z0-9]+$/;
const telegramId = /^[1-9]\d{0,15}$/;
const groupId = /^-[1-9]\d{0,15}$/;
const timestamp = /^\d+\.\d{6}$/;

function list(value, pattern) {
  const values = value ? value.split(',').map(s => s.trim()) : [];
  if (values.some(v => !pattern.test(v))) throw Error('invalid_configuration');
  return new Set(values);
}

export function config(env) {
  const allPrivate = env.TELEGRAM_PRIVATE_CHATS === '*';
  const chats = list(allPrivate ? '' : env.TELEGRAM_PRIVATE_CHATS, telegramId);
  const groups = list(env.TELEGRAM_GROUP_IDS, groupId);
  const channels = list(env.TELEGRAM_CHANNEL_IDS, groupId);
  const users = list(env.SLACK_ALLOWED_USERS, slackUser);
  const owner = env.TELEGRAM_OWNER_ID || '';
  if (!/^T[A-Z0-9]+$/.test(env.SLACK_TEAM_ID) || !/^A[A-Z0-9]+$/.test(env.SLACK_APP_ID)
      || !/^[CG][A-Z0-9]+$/.test(env.SLACK_CHANNEL_ID) || !users.size
      || !env.SLACK_SIGNING_SECRET || !env.SLACK_BOT_TOKEN
      || !/^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN)
      || !/^[\w-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)
      || !(allPrivate || chats.size || groups.size || channels.size)
      || ((allPrivate || chats.size) && !telegramId.test(owner))
      || (env.TELEGRAM_OWNER_CONTEXT && !['true', 'false'].includes(env.TELEGRAM_OWNER_CONTEXT))
      || (env.SLACK_OWNER_USER_ID && !users.has(env.SLACK_OWNER_USER_ID))
      || (env.TELEGRAM_USER_SESSION && !(telegramId.test(owner) && env.TELEGRAM_API_HASH && env.TELEGRAM_API_ID))) {
    throw Error('invalid_configuration');
  }
  const installation = [env.SLACK_TEAM_ID, env.SLACK_APP_ID, env.SLACK_CHANNEL_ID,
    env.TELEGRAM_BOT_TOKEN.split(':')[0], owner].join('/');
  return { owner, allPrivate, chats, groups, channels, users, installation,
    channel: env.SLACK_CHANNEL_ID, slackOwner: env.SLACK_OWNER_USER_ID || '', connection: env.TELEGRAM_BUSINESS_CONNECTION_ID || '',
    ownerContext: env.TELEGRAM_OWNER_CONTEXT === 'true' };
}

export function allowed(route, c) {
  if (route.kind === 'business') return route.ownerId === c.owner && route.chatId !== c.owner
    && (!c.connection || route.connectionId === c.connection)
    && (c.allPrivate || c.chats.has(route.chatId));
  return (route.kind === 'channel' ? c.channels : c.groups).has(route.chatId);
}

// Route identity never depends on a display name or username.
export const routeKey = r => JSON.stringify([r.kind, r.connectionId || '', r.chatId, r.topicId || 0]);

function displayName(person) {
  return [person?.first_name, person?.last_name].filter(Boolean).join(' ') || person?.title || person?.username || '';
}

function mediaOf(m) {
  const photo = Array.isArray(m.photo) && m.photo.reduce((a, b) =>
    a && a.width * a.height >= b.width * b.height ? a : b, null);
  const kind = photo ? 'photo' : ['document', 'voice', 'audio', 'video', 'video_note', 'animation', 'sticker'].find(k => m[k]?.file_id);
  if (!kind) return null;
  const { file_id, file_size, file_name, mime_type } = photo || m[kind];
  return { kind, file_id, file_size, file_name, mime_type };
}

function summary(m) {
  if (m.location) return [m.location.latitude, m.location.longitude].join(', ');
  if (m.venue) return [m.venue.title, m.venue.address].filter(Boolean).join('\n');
  if (m.contact) return [displayName(m.contact), m.contact.phone_number].filter(Boolean).join('\n');
  if (m.poll) return [m.poll.question, ...(m.poll.options || []).map(o => o.text)].join('\n');
  if (m.dice) return [m.dice.emoji, m.dice.value].join(' ');
  return '[Open Telegram to view this message]';
}

export function telegramJob(u, c, now) {
  const m = u.business_message || u.channel_post || u.message;
  if (!Number.isSafeInteger(u.update_id) || u.update_id < 0 || !Number.isSafeInteger(m?.message_id)
      || m.message_id <= 0 || !Number.isSafeInteger(m.chat?.id) || !Number.isSafeInteger(m.date)
      || m.date < now - 86400 || m.date > now + 60 || m.sender_business_bot || m.via_bot) return null;
  const chatId = String(m.chat.id);
  let route;
  let ownerOutgoing = false;
  if (u.business_message && m.chat.type === 'private' && typeof m.business_connection_id === 'string' && m.business_connection_id) {
    ownerOutgoing = String(m.from?.id) === c.owner;
    if (m.from?.is_bot || (ownerOutgoing ? !c.ownerContext : String(m.from?.id) !== chatId)) return null;
    route = { kind: 'business', chatId, connectionId: m.business_connection_id, ownerId: c.owner };
  } else if (u.channel_post && m.chat.type === 'channel') {
    route = { kind: 'channel', chatId };
  } else if (u.message && ['group', 'supergroup'].includes(m.chat.type) && (!m.from?.is_bot || m.sender_chat)) {
    route = { kind: 'group', chatId };
    if (m.is_topic_message && Number.isSafeInteger(m.message_thread_id) && m.message_thread_id > 0) route.topicId = m.message_thread_id;
  } else return null;
  if (!allowed(route, c)) return null;
  const media = mediaOf(m);
  const author = ownerOutgoing ? 'You' : displayName(m.sender_chat || m.from);
  const label = displayName(m.chat) || chatId;
  return { id: 'tg:' + u.update_id, type: 'incoming', route, label, author,
    username: m.chat.username || '', date: m.date, messageId: m.message_id, ownerOutgoing, media,
    text: m.text || m.caption || (media ? '[' + media.kind + ']' : summary(m)) };
}

export function slackPlainText(text) {
  return text.replace(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g, (_, url, label) =>
    !label || label === url || label === url.replace(/^https?:\/\//, '') ? url : label + ' (' + url + ')')
    .replace(/<tel:([^>|]+)(?:\|([^>]+))?>/g, (_, number, label) => label || number)
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function slackJob(body, env, c, now) {
  const e = body.event;
  if (body.type !== 'event_callback' || body.team_id !== env.SLACK_TEAM_ID || body.api_app_id !== env.SLACK_APP_ID
      || !/^Ev[A-Za-z0-9]+$/.test(body.event_id || '') || e?.type !== 'message' || e.channel !== env.SLACK_CHANNEL_ID
      || !c.users.has(e.user) || (e.thread_ts && !timestamp.test(e.thread_ts)) || !timestamp.test(e.ts || '')
      || +e.ts < now - 600 || +e.ts > now + 60 || e.edited || e.bot_id || e.app_id || e.bot_profile
      || (e.subtype && e.subtype !== 'file_share') || typeof e.text !== 'string') return null;
  const raw = slackPlainText(e.text.trim());
  const base = { id: 'slack:' + body.event_id, user: e.user, thread: e.thread_ts || e.ts, date: Math.floor(+e.ts) };
  if (!e.files?.length && !e.subtype) {
    const contact = parseContactCommand(raw);
    if (contact && (e.thread_ts || contact.action === 'add_phone' || contact.action === 'read'))
      return { ...base, type: 'account', action: 'contact', contact };
    const open = parseOpenChat(raw);
    if (open && c.slackOwner === e.user) return { ...base, type: 'account', action: 'open', open };
  }
  if (!e.thread_ts || e.thread_ts === e.ts) return null;
  if (!e.files?.length && !e.subtype) {
    if (raw === '!tg-read-status') return { ...base, type: 'account', action: 'read' };
    if (/^!tg-edit(?:\s|$)/.test(raw)) {
      const parts = /^!tg-edit\s+([1-9]\d*)\s+([\s\S]+)$/.exec(raw);
      return { ...base, type: 'account', action: 'edit', messageId: Number(parts?.[1]) || 0, text: parts?.[2] || '' };
    }
    const schedule = parseSchedule(raw);
    if (schedule) return { ...base, type: 'schedule', schedule };
  }
  const cmd = /^!tg-send(?:-now)?(?:\s+([\s\S]*))?$/.exec(e.text.trim());
  if (!cmd) return null;
  const text = slackPlainText((cmd[1] || '').trim());
  const files = e.files || [];
  const invalid = !Array.isArray(files) || files.length > 1 || files.some(f => !/^F[A-Z0-9]+$/.test(f?.id || ''))
    || text.length > (files.length ? 1024 : 4096) || (!files.length && !text);
  return { id: 'slack:' + body.event_id, type: 'outgoing', user: e.user, thread: e.thread_ts,
    date: Math.floor(+e.ts), text, fileId: invalid ? null : files[0]?.id || null, invalid };
}
