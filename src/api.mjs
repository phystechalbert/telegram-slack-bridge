const TG_LIMIT = 20 * 1024 * 1024;
const PDF_LIMIT = 5 * 1024 * 1024;
export class ApiError extends Error {
  constructor(code, retryAfter) {
    super(code); this.name = 'ApiError'; this.code = code;
    if (Number.isFinite(retryAfter) && retryAfter > 0) this.retryAfter = retryAfter;
  }
}
const fail = code => { throw new ApiError(code); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const slackId = id => typeof id === 'string' && /^F[A-Z0-9]+$/.test(id);
const ts = value => typeof value === 'string' && /^\d+\.\d+$/.test(value);
const escapeText = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function filename(value) {
  return String(value || 'telegram-file').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100).replace(/^[. ]+/, '') || 'telegram-file';
}
function fileUrl(raw) {
  let u; try { u = new URL(raw); } catch { fail('unsafe_file_url'); }
  if (u.protocol !== 'https:' || u.hostname !== 'files.slack.com' || u.username || u.password || u.port) fail('unsafe_file_url');
  return u.href;
}
async function readBounded(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => {}); fail('body_too_large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) fail('body_too_large'); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof ApiError) throw error; throw new ApiError('transport', 20); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}
export class Api {
  constructor(env, http = fetch) { this.env = env; this.http = http; }
  channel() {
    if (!/^[CG][A-Z0-9]+$/.test(this.env.SLACK_CHANNEL_ID || '')) fail('invalid_channel');
    return this.env.SLACK_CHANNEL_ID;
  }
  token(kind) {
    const token = this.env[kind === 'slack' ? 'SLACK_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'];
    if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token) || (kind === 'telegram' && !/^\d+:[A-Za-z0-9_-]+$/.test(token))) fail('invalid_credentials');
    return token;
  }
  async request(url, init = {}, mutating = false) {
    let response;
    try { response = await this.http.call(globalThis, url, {...init, redirect: 'manual', signal: AbortSignal.timeout(25000)}); }
    catch { throw new ApiError(mutating ? 'ambiguous' : 'transport', mutating ? undefined : 20); }
    if (response.status === 429) {
      let delay = Number(response.headers.get('retry-after')) || 0;
      try { const body = JSON.parse(new TextDecoder().decode(await readBounded(response, 16000))); delay = Math.max(delay, Number(body.parameters?.retry_after) || 0); } catch { /* sanitized */ }
      throw new ApiError('rate_limited', delay > 0 ? delay : 30);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500) throw new ApiError(mutating ? 'ambiguous' : 'transport', mutating ? undefined : 20);
      throw new ApiError(response.status >= 300 && response.status < 400 ? 'redirect_rejected' : 'remote_rejected');
    }
    return response;
  }
  async json(url, init, mutating = false) {
    const response = await this.request(url, init, mutating); let data;
    try { data = JSON.parse(new TextDecoder().decode(await readBounded(response, 256000))); }
    catch { throw new ApiError(mutating ? 'ambiguous' : 'invalid_response', mutating ? undefined : 20); }
    if (data?.ok !== true) {
      if (data?.error_code === 429 || data?.error === 'ratelimited') throw new ApiError('rate_limited', Number(data.parameters?.retry_after) > 0 ? Number(data.parameters.retry_after) : 30);
      if (data?.error_code >= 500 || ['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable'].includes(data?.error)) throw new ApiError(mutating ? 'ambiguous' : 'transport', mutating ? undefined : 20);
      if (data?.ok === false) fail('api_rejected');
      throw new ApiError(mutating ? 'ambiguous' : 'invalid_response', mutating ? undefined : 20);
    }
    return data;
  }
  async slack(method, fields, mutating = false) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return this.json(`https://slack.com/api/${method}`, {method: 'POST', headers: {authorization: `Bearer ${this.token('slack')}`, 'content-type': 'application/x-www-form-urlencoded'}, body}, mutating);
  }
  async telegram(method, fields, mutating = false) {
    return (await this.json(`https://api.telegram.org/bot${this.token('telegram')}/${method}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(fields)}, mutating)).result;
  }
  async assertChannel() {
    const id = this.channel(); const {channel} = await this.slack('conversations.info', {channel: id});
    if (channel?.id !== id || channel.is_private !== true || channel.is_member !== true || channel.is_archived || channel.is_shared || channel.is_ext_shared || channel.is_org_shared || channel.is_pending_ext_shared || (channel.pending_shared?.length > 0) || (channel.shared_team_ids?.length > 1)) fail('channel_not_private_local');
  }
  async assertBusiness(connectionId, ownerId, requireReply = true) {
    if (typeof connectionId !== 'string' || !connectionId || !/^\d+$/.test(String(ownerId))) fail('business_not_authorized');
    const connection = await this.telegram('getBusinessConnection', {business_connection_id: connectionId});
    if (connection?.id !== connectionId || String(connection.user?.id) !== String(ownerId) || connection.is_enabled !== true || (requireReply && connection.rights?.can_reply !== true)) fail('business_not_authorized');
  }
  async post(text, thread) {
    if (thread !== undefined && !ts(thread)) fail('invalid_thread');
    const result = await this.slack('chat.postMessage', {channel: this.channel(), text: escapeText(text), thread_ts: thread, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false}, true);
    if (result.channel !== this.channel() || !ts(result.ts)) fail('ambiguous');
    return result.ts;
  }
  async uploadTelegram(media, thread, caption) {
    this.channel();
    if (!media || typeof media.file_id !== 'string' || !media.file_id || (media.file_size !== undefined && (!positive(media.file_size) || media.file_size > TG_LIMIT))) fail('invalid_telegram_file');
    if (!ts(thread)) fail('invalid_thread');
    const file = await this.telegram('getFile', {file_id: media.file_id});
    if (file?.file_id !== media.file_id || !positive(file.file_size) || file.file_size > TG_LIMIT || (media.file_size !== undefined && media.file_size !== file.file_size) || typeof file.file_path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.file_path) || file.file_path.includes('..')) fail('invalid_telegram_file');
    const response = await this.request(`https://api.telegram.org/file/bot${this.token('telegram')}/${file.file_path}`);
    const bytes = await readBounded(response, TG_LIMIT);
    if (bytes.length !== file.file_size) fail('file_size_mismatch');
    const name = filename(media.file_name || file.file_path.split('/').pop());
    const allocated = await this.slack('files.getUploadURLExternal', {filename: name, length: bytes.length}, true);
    if (!slackId(allocated.file_id)) fail('ambiguous');
    let completion = false;
    try {
      const url = fileUrl(allocated.upload_url);
      const uploaded = await this.request(url, {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: bytes}, true);
      await uploaded.body?.cancel();
      completion = true;
      const result = await this.slack('files.completeUploadExternal', {files: [{id: allocated.file_id, title: name}], channel_id: this.channel(), thread_ts: thread, initial_comment: escapeText(caption)}, true);
      if (!Array.isArray(result.files) || !result.files.some(item => item.id === allocated.file_id)) fail('ambiguous');
    } catch {
      // Replaying this composite operation can allocate/upload another file.
      throw new ApiError(completion ? 'upload_completion_ambiguous' : 'upload_incomplete');
    }
  }
  async getSlackPdf(fileId) {
    if (!slackId(fileId)) fail('invalid_file');
    const {file} = await this.slack('files.info', {file: fileId});
    const channel = this.channel();
    const shared = [...(Array.isArray(file?.groups) ? file.groups : []), ...(Array.isArray(file?.channels) ? file.channels : [])];
    if (file?.id !== fileId || file.is_external || !shared.includes(channel)) fail('file_not_in_channel');
    if (file.mimetype !== 'application/pdf' || typeof file.name !== 'string' || !/\.pdf$/i.test(file.name) || !positive(file.size) || file.size < 6 || file.size > PDF_LIMIT) fail('invalid_pdf');
    const response = await this.request(fileUrl(file.url_private_download || file.url_private), {headers: {authorization: `Bearer ${this.token('slack')}`}});
    const bytes = await readBounded(response, PDF_LIMIT);
    if (bytes.length !== file.size || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') fail('invalid_pdf');
    return {bytes, name: filename(file.name)};
  }
  async sendBot(route, text, file) {
    if (!route || !/^-?\d+$/.test(String(route.chatId)) || String(route.chatId) === '0' || (route.connectionId !== undefined && (typeof route.connectionId !== 'string' || !route.connectionId)) || (route.topicId !== undefined && !positive(route.topicId))) fail('invalid_route');
    const fields = {chat_id: route.chatId, business_connection_id: route.connectionId, message_thread_id: route.topicId};
    let result;
    if (file) {
      if (!(file.bytes instanceof Uint8Array) || file.bytes.length < 6 || file.bytes.length > PDF_LIMIT || new TextDecoder().decode(file.bytes.subarray(0, 5)) !== '%PDF-' || !/\.pdf$/i.test(file.name || '')) fail('invalid_pdf');
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.set(key, String(value));
      form.set('caption', String(text ?? '')); form.set('document', new Blob([file.bytes], {type: 'application/pdf'}), filename(file.name));
      result = (await this.json(`https://api.telegram.org/bot${this.token('telegram')}/sendDocument`, {method: 'POST', body: form}, true)).result;
    } else {
      result = await this.telegram('sendMessage', {...fields, text: String(text ?? ''), link_preview_options: {is_disabled: true}}, true);
    }
    if (!positive(result?.message_id) || String(result.chat?.id) !== String(route.chatId) || (route.connectionId !== undefined && result.business_connection_id !== route.connectionId) || (route.topicId !== undefined && result.message_thread_id !== route.topicId)) fail('ambiguous');
    return result.message_id;
  }
}
