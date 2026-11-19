// Cloudflare SQLite cursors are synchronous. Commit the intent before each external write.
export class Store {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT, due INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', finished INTEGER
    );
    CREATE TABLE IF NOT EXISTS conversations (
      route_key TEXT PRIMARY KEY, route TEXT NOT NULL, thread TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL, last_inbound INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opens (id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sent (
      route_key TEXT NOT NULL, message_id INTEGER NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (route_key, message_id)
    );`);
  }

  one(query, ...args) { return [...this.sql.exec(query, ...args)][0]; }
  enqueue(job) {
    this.sql.exec('INSERT OR IGNORE INTO jobs(id, body, due) VALUES(?,?,?)', job.id, JSON.stringify(job), Date.now());
  }
  next() { return this.one("SELECT * FROM jobs WHERE status='queued' ORDER BY due, seq LIMIT 1"); }
  delay(id, due) { this.sql.exec('UPDATE jobs SET attempts=attempts+1, due=? WHERE id=?', due, id); }
  finish(id, status) {
    this.sql.exec('UPDATE jobs SET status=?, body=NULL, finished=? WHERE id=?', status, Date.now(), id);
  }
  route(key) { return this.one('SELECT * FROM conversations WHERE route_key=?', key); }
  thread(ts) { return this.one('SELECT * FROM conversations WHERE thread=?', ts); }
  businessChat(chatId, c) {
    const rows = [...this.sql.exec("SELECT * FROM conversations WHERE json_extract(route,'$.chatId')=? AND json_extract(route,'$.kind')='business'", chatId)];
    const current = rows.filter(row => !c.connection || JSON.parse(row.route).connectionId === c.connection);
    return current.length === 1 ? current[0] : null;
  }
  claimOpen(id, kind, limit) {
    this.sql.exec('DELETE FROM opens WHERE at < ?', Date.now() - 86400000);
    const key = kind + ':' + id;
    if (this.one('SELECT 1 FROM opens WHERE id=?', key)) return true;
    if (this.one('SELECT COUNT(*) AS n FROM opens WHERE kind=?', kind).n >= limit) return false;
    this.sql.exec('INSERT INTO opens VALUES(?,?,?)', key, kind, Date.now());
    return true;
  }
  remember(key, route, thread, username, date) {
    this.sql.exec(`INSERT INTO conversations VALUES(?,?,?,?,?)
      ON CONFLICT(route_key) DO UPDATE SET username=excluded.username,
      last_inbound=MAX(conversations.last_inbound, excluded.last_inbound)`,
      key, JSON.stringify(route), thread, username, date);
  }
  markSent(key, messageId) {
    this.sql.exec('INSERT OR IGNORE INTO sent VALUES(?,?,?)', key, messageId, Date.now());
  }
  wasSent(key, messageId) {
    return !!this.one('SELECT 1 FROM sent WHERE route_key=? AND message_id=?', key, messageId);
  }
  async effect(id, perform) {
    const old = this.one('SELECT state, value FROM effects WHERE id=?', id);
    if (old?.state === 'done') return JSON.parse(old.value);
    if (old) throw Error('unconfirmed_effect');
    this.sql.exec("INSERT INTO effects VALUES(?, 'started', NULL, ?)", id, Date.now());
    let value;
    try {
      value = (await perform()) ?? null;
    } catch (error) {
      if (error.retryAfter > 0 || (id.startsWith('root:') && ['api_rejected', 'remote_rejected'].includes(error.code))) {
        this.sql.exec('DELETE FROM effects WHERE id=?', id);
      }
      throw error;
    }
    this.sql.exec("UPDATE effects SET state='done', value=?, updated=? WHERE id=?", JSON.stringify(value), Date.now(), id);
    return value;
  }
  prune() {
    const cutoff = Date.now() - 7 * 86400000;
    this.sql.exec('DELETE FROM jobs WHERE finished < ?', cutoff);
    if (this.one("SELECT 1 FROM sqlite_master WHERE name='scheduled_sends'")) {
      this.sql.exec('DELETE FROM scheduled_sends WHERE job_id NOT IN (SELECT id FROM jobs)');
      this.sql.exec('DELETE FROM schedule_receipts WHERE id NOT IN (SELECT id FROM jobs)');
    }
    this.sql.exec('DELETE FROM sent WHERE created < ?', cutoff);
    this.sql.exec("DELETE FROM effects WHERE updated < ? AND id NOT LIKE 'root:%'", cutoff);
  }
}
