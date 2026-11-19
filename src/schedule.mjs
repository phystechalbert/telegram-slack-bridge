const MIN_AHEAD = 60, MAX_AHEAD = 72 * 3600;
const usage = 'Use !tg-send-at YYYY-MM-DDTHH:MM+HH:MM text, !tg-send-list, or !tg-send-cancel S-id|all.';
export function parseSchedule(text) {
  if (typeof text !== 'string' || !/^!tg-send-(at|list|cancel)(?:\s|$)/.test(text)) return null;
  if (text === '!tg-send-list') return {action: 'list'};
  const cancel = /^!tg-send-cancel (all|S-[0-9a-f]{8})$/i.exec(text);
  if (cancel) return {action: 'cancel', target: cancel[1].toLowerCase() === 'all' ? 'all' : 'S-' + cancel[1].slice(2).toLowerCase()};
  const m = /^!tg-send-at\s+(\S+)\s+([\s\S]+)$/.exec(text.trimEnd());
  const invalid = {action: text.startsWith('!tg-send-list') ? 'list' : text.startsWith('!tg-send-cancel') ? 'cancel' : 'create', invalid: true};
  if (!m) return invalid;
  const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(m[1]);
  if (!t) return invalid;
  const [y, mo, d, h, mi, s] = [1,2,3,4,5,6].map(i => Number(t[i] || 0));
  const offset = t[7] === 'Z' ? 0 : (t[8] === '-' ? -1 : 1) * (Number(t[9]) * 60 + Number(t[10]));
  const local = Date.UTC(y, mo - 1, d, h, mi, s), back = new Date(local);
  const content = m[2].trim();
  if (h > 23 || mi > 59 || s > 59 || Number(t[10] || 0) > 59 || Math.abs(offset) > 840 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || !content || content.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) return invalid;
  return {action: 'create', at: local / 1000 - offset * 60, text: content};
}
function ensure(store) {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS scheduled_sends (
    event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, short TEXT NOT NULL UNIQUE,
    thread TEXT NOT NULL, send_at INTEGER NOT NULL, text_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, cancelled_by TEXT
  );
  CREATE TABLE IF NOT EXISTS schedule_receipts (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL
  );`);
}
async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');
}
const pending = "j.status='queued' AND j.attempts=0 AND j.body IS NOT NULL AND s.cancelled_by IS NULL";
const atText = at => new Date(at * 1000).toISOString();
export async function scheduleCommand(store, job, now) {
  if (!job || typeof job.id !== 'string' || !job.id || typeof job.user !== 'string' || !job.user || !/^\d+\.\d+$/.test(job.thread || '') || !Number.isSafeInteger(now)) return 'Schedule rejected: invalid job.';
  const request = job.schedule;
  if (!request || request.invalid || !['create','list','cancel'].includes(request.action)) return usage;
  const fingerprint = await hash(JSON.stringify({request, user: job.user, thread: job.thread}));
  const short = 'S-' + (await hash('schedule:' + job.id)).slice(0, 8);
  ensure(store);
  const receipt = store.one('SELECT * FROM schedule_receipts WHERE id=?', job.id);
  if (receipt) return receipt.fingerprint === fingerprint ? receipt.result : 'Schedule rejected: conflicting event.';
  const finish = result => {
    store.sql.exec('INSERT INTO schedule_receipts(id,fingerprint,result) VALUES(?,?,?)', job.id, fingerprint, result);
    return result;
  };
  if (request.action === 'list') {
    const rows = [...store.sql.exec(`SELECT s.short,s.send_at FROM scheduled_sends s JOIN jobs j ON j.id=s.job_id WHERE s.thread=? AND ${pending} ORDER BY s.send_at,s.short`, job.thread)];
    return finish(rows.length ? 'Pending sends in this thread:\n' + rows.map(r => `${r.short} · ${atText(r.send_at)}`).join('\n') : 'No pending sends in this thread.');
  }
  if (request.action === 'cancel') {
    if (request.target !== 'all' && !/^S-[0-9a-f]{8}$/.test(request.target || '')) return finish(usage);
    const scope = request.target === 'all' ? '' : ' AND s.short=?';
    const values = request.target === 'all' ? [job.thread] : [job.thread, request.target];
    const rows = [...store.sql.exec(`SELECT s.job_id,s.short FROM scheduled_sends s JOIN jobs j ON j.id=s.job_id WHERE s.thread=? AND ${pending}${scope}`, ...values)];
    for (const row of rows) {
      store.sql.exec('UPDATE scheduled_sends SET cancelled_by=? WHERE job_id=?', job.id, row.job_id);
      store.sql.exec("UPDATE jobs SET status='cancelled',body=NULL,finished=? WHERE id=? AND status='queued' AND attempts=0", now * 1000, row.job_id);
    }
    const cancelled = [...store.sql.exec('SELECT short FROM scheduled_sends WHERE cancelled_by=? AND thread=? ORDER BY short', job.id, job.thread)];
    return finish(cancelled.length ? 'Cancelled: ' + cancelled.map(r => r.short).join(', ') : 'No cancellable pending sends matched in this thread.');
  }
  if (!Number.isSafeInteger(request.at) || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(request.text) || job.fileId != null) return finish('Schedule rejected: only valid text can be scheduled.');
  const old = store.one('SELECT * FROM scheduled_sends WHERE event_id=?', job.id);
  if (old && old.fingerprint !== fingerprint) return finish('Schedule rejected: conflicting event.');
  if (!old) {
    if (request.at < now + MIN_AHEAD) return finish('Schedule rejected: choose a time at least one minute ahead.');
    if (request.at > now + MAX_AHEAD) return finish('Schedule rejected: choose a time within 72 hours.');
    const key = await hash(request.text.replace(/\s+/gu, ' ').trim());
    // All following checks and writes are synchronous on the DO alarm turn.
    const same = store.one(`SELECT s.short FROM scheduled_sends s JOIN jobs j ON j.id=s.job_id WHERE s.thread=? AND s.text_key=? AND ${pending} LIMIT 1`, job.thread, key);
    if (same) return finish('Schedule rejected: same text already pending · ' + same.short);
    const count = store.one(`SELECT COUNT(*) AS total,COALESCE(SUM(s.thread=?),0) AS here FROM scheduled_sends s JOIN jobs j ON j.id=s.job_id WHERE ${pending}`, job.thread);
    if (count.here >= 6) return finish('Schedule rejected: this thread already has 6 pending sends.');
    if (count.total >= 200) return finish('Schedule rejected: 200 sends are already pending.');
    const collision = store.one('SELECT event_id FROM scheduled_sends WHERE short=?', short);
    if (collision) return finish('Schedule rejected: identifier collision.');
    store.sql.exec('INSERT INTO scheduled_sends(event_id,job_id,short,thread,send_at,text_key,fingerprint) VALUES(?,?,?,?,?,?,?)', job.id, 'scheduled:' + job.id, short, job.thread, request.at, key, fingerprint);
  }
  const derivedId = 'scheduled:' + job.id;
  const body = {type: 'outgoing', id: derivedId, user: job.user, thread: job.thread, date: request.at, scheduled: true, text: request.text, fileId: null};
  store.sql.exec('INSERT OR IGNORE INTO jobs(id,body,due) VALUES(?,?,?)', derivedId, JSON.stringify(body), request.at * 1000);
  return finish(`Scheduled for ${atText(request.at)} · ${old?.short || short}\nCancel: !tg-send-cancel ${old?.short || short}`);
}
