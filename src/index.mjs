import { DurableObject } from 'cloudflare:workers';
import { Api } from './api.mjs';
import { ingress } from './ingress.mjs';
import { config } from './routes.mjs';
import { Store } from './store.mjs';
import { deliver } from './relay.mjs';
import { accountClient } from './account-actions.mjs';

export default { fetch: ingress };

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
  }

  async fetch(request) {
    const { installation, job } = await request.json();
    if (this.ctx.id.toString() !== this.env.RELAY.idFromName(installation).toString()) return new Response(null, { status: 403 });
    this.store.enqueue(job);
    // Acknowledgement follows both the durable insert and the scheduled wake-up.
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return new Response(null, { status: 200 });
  }

  async alarm() {
    const row = this.store.next();
    if (!row) return;
    if (row.due > Date.now()) { await this.ctx.storage.setAlarm(row.due); return; }
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    const job = JSON.parse(row.body);
    const api = new Api(this.env);
    try {
      const c = config(this.env);
      if (this.env.RELAY.idFromName(c.installation).toString() !== this.ctx.id.toString()) {
        this.store.finish(job.id, 'installation_changed');
      } else {
        await deliver(job, c, this.store, api, accountClient(this.env), Math.floor(Date.now() / 1000));
        this.store.finish(job.id, 'done');
      }
    } catch (error) {
      if (error.retryAfter > 0 && row.attempts < 5) {
        this.store.delay(job.id, Date.now() + 1000 * Math.max(2 ** row.attempts, error.retryAfter));
      } else {
        console.warn('relay_delivery_unconfirmed', job.type);
        this.store.finish(job.id, 'unconfirmed');
        if (job.type === 'outgoing' && this.store.thread(job.thread)
            && this.ctx.id.toString() === this.env.RELAY.idFromName(config(this.env).installation).toString()) {
          try {
            await api.assertChannel();
            await api.post('Delivery was not confirmed. Check Telegram before sending again.', job.thread);
          } catch { console.warn('relay_notice_unconfirmed'); }
        }
      }
    }
    this.store.prune();
    const next = this.store.next();
    if (next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, next.due));
  }
}
