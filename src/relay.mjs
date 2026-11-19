import { allowed, routeKey } from './routes.mjs';
import { accountCommand, rootText } from './account-actions.mjs';
import { scheduleCommand } from './schedule.mjs';

export async function deliver(job, c, store, api, account, now) {
  if (job.type === 'incoming') {
    const { route } = job;
    if (!allowed(route, c) || (job.ownerOutgoing && !c.ownerContext)) return;
    const key = routeKey(route);
    const conversation = store.route(key);
    if ((job.ownerOutgoing && !conversation) || store.wasSent(key, job.messageId)) return;
    await api.assertChannel();
    if (route.kind === 'business') await api.assertBusiness(route.connectionId, route.ownerId, false);
    const saved = route.kind === 'business' && account ? await account.savedName({
      ...(conversation ? JSON.parse(conversation.route) : route), username: job.username
    }) : '';
    const thread = conversation?.thread || await store.effect('root:' + key, () =>
      api.post(rootText(route, saved || job.label)));
    store.remember(key, route, thread, job.username, job.ownerOutgoing ? 0 : job.date);
    const author = (job.ownerOutgoing ? job.author : saved || job.author) || 'Telegram';
    const text = author + ' · #' + job.messageId + '\n' + job.text;
    await store.effect(job.id + '/text', () => api.post(text, thread));
    if (job.media) {
      try {
        await store.effect(job.id + '/file', () => api.uploadTelegram(job.media, thread, ''));
      } catch (error) {
        if (error.retryAfter > 0) throw error;
        await store.effect(job.id + '/file-notice', () =>
          api.post('Attachment delivery was not confirmed. Open the original in Telegram.', thread));
      }
    }
    return;
  }

  if (!c.users.has(job.user)) return;
  if (job.type === 'account') {
    await api.assertChannel();
    let report;
    try {
      report = await store.effect(job.id + '/account', () => accountCommand(job, c, store, api, account, now));
    } catch (error) {
      if (error.retryAfter > 0) throw error;
      const known = /^(tg_(edit|read|message)_[a-z_]+|MESSAGE_[A-Z_]+|FLOOD_WAIT_\d+)$/.test(error.message);
      report = 'Telegram operation was not confirmed.' + (known ? ' ' + error.message : '');
    }
    if (report) await store.effect(job.id + '/account-report', () => api.post(report, job.thread));
    return;
  }
  const conversation = store.thread(job.thread);
  if (!conversation) return;
  const route = JSON.parse(conversation.route);
  if (!allowed(route, c)) return;
  await api.assertChannel();
  const notice = message => store.effect(job.id + '/notice', () => api.post(message, job.thread));
  if (route.kind === 'channel' && job.user !== c.slackOwner) {
    await notice('Only the configured Slack owner can publish to a Telegram channel.');
    return;
  }
  if (job.type === 'schedule') {
    const status = await scheduleCommand(store, job, now);
    await notice(status);
    return;
  }
  if (job.invalid) {
    await notice('Use !tg-send with up to 4096 text characters, or attach one PDF with a caption of up to 1024 characters.');
    return;
  }
  if (now - job.date > (job.scheduled ? 900 : 600) || now < job.date - 60) {
    await notice('This send command expired. Check Telegram before issuing a new command.');
    return;
  }
  const business = route.kind === 'business';
  const viaUser = business && !!account;
  if (business) {
    await api.assertBusiness(route.connectionId, route.ownerId, !viaUser);
    if (!viaUser && now - conversation.last_inbound >= 86400) {
      await notice('The Telegram Business reply window has closed. Reopen the conversation in Telegram.');
      return;
    }
  }
  // Read the attachment before recording any irreversible Telegram send.
  const sent = await store.effect(job.id + '/send', async () => {
    const file = job.fileId ? await api.getSlackPdf(job.fileId) : null;
    return viaUser
      ? account.send({ ...route, username: conversation.username, eventId: job.id, text: job.text, file })
      : api.sendBot(route, job.text, file);
  });
  store.markSent(conversation.route_key, sent);
  await store.effect(job.id + '/receipt', () => api.post('Sent to Telegram · message ' + sent, job.thread));
}
