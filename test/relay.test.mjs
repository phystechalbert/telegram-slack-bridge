import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { config, telegramJob, slackJob, routeKey } from '../src/routes.mjs';
import { deliver } from '../src/relay.mjs';
import { Store } from '../src/store.mjs';

const now = 1800000000;
const env = { SLACK_TEAM_ID: 'TTEST', SLACK_APP_ID: 'ATEST', SLACK_CHANNEL_ID: 'GTEST', SLACK_ALLOWED_USERS: 'UTEST',
  TELEGRAM_OWNER_ID: '10', TELEGRAM_PRIVATE_CHATS: '20,21', TELEGRAM_GROUP_IDS: '-30', TELEGRAM_CHANNEL_IDS: '-40',
  TELEGRAM_BOT_TOKEN: '1:local', TELEGRAM_WEBHOOK_SECRET: 'fake', SLACK_SIGNING_SECRET: 'fake', SLACK_BOT_TOKEN: 'fake' };
const c = config(env);
const route = {kind: 'business', ownerId: '10', chatId: '20', connectionId: 'fixture'};
const thread = now + '.000001';
function command(text, changes = {}) {
  return slackJob({team_id: 'TTEST', api_app_id: 'ATEST', type: 'event_callback', event_id: 'EvTest',
    event: {type: 'message', ts: now + '.000007', thread_ts: thread, user: 'UTEST', channel: 'GTEST', text, ...changes}}, env, c, now);
}
function harness() {
  const db = new DatabaseSync(':memory:');
  const store = new Store({exec(query, ...args) {
    if (/^\s*CREATE/i.test(query)) { db.exec(query); return []; }
    const statement = db.prepare(query);
    if (/^\s*SELECT/i.test(query)) return statement.all(...args);
    statement.run(...args); return [];
  }});
  const posts = [];
  const api = {assertChannel: async () => {}, assertBusiness: async () => {}, post: async text => { posts.push(text); return thread; }};
  return { store, api, posts };
}

test('contact names and Telegram message IDs are visible on incoming text', async () => {
  const { store, api, posts } = harness();
  const m = {message_id: 5, chat: {id: 20, type: 'private'}, from: {id: 20, first_name: 'Public name'},
    business_connection_id: 'fixture', date: now, text: 'Hello'};
  const job = telegramJob({update_id: 1, business_message: m}, c, now);
  const account = { savedName: async () => 'Saved name' };
  await deliver(job, c, store, api, account, now);
  await deliver(job, c, store, api, account, now);
  assert.match(posts[0], /Saved name[\s\S]*Chat ID: 20/);
  assert.deepEqual(posts.slice(1), ['Saved name · #5\nHello']);
});

test('edit command stays bound to the private thread and is executed once', async () => {
  const { store, api, posts } = harness();
  store.remember(routeKey(route), route, thread, '', now);
  assert.equal(command('!tg-edit 55 New', {bot_id: 'BTEST'}), null);
  assert.equal(command('!tg-edit 55 New', {user: 'UOUTSIDE'}), null);
  assert.equal(command('!tg-edit 55 New', {subtype: 'message_changed'}), null);
  const calls = [];
  const account = {edit: async args => {calls.push(args); return 'Verified change';}};
  const job = command('!tg-edit 55 New &amp; improved');
  await deliver(job, c, store, api, account, now);
  await deliver(job, c, store, api, account, now);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].chatId, calls[0].messageId, calls[0].text], ['20', 55, 'New & improved']);
  assert.deepEqual(posts, ['Verified change']);
});

test('rename with another chat ID cannot reach Telegram', async () => {
  const { store, api, posts } = harness();
  store.remember(routeKey(route), route, thread, '', now);
  const job = command('!tg-contact-rename '+JSON.stringify({chat_id:'21', first_name:'New', last_name:'', expected_first_name:'Old', expected_last_name:''}));
  await deliver(job, c, store, api, {}, now);
  assert.deepEqual(posts, ['This command requires the matching private chat.']);
});

test('forum topics have separate routes and only the Slack owner may publish to a channel', async () => {
  const m = {chat:{id:-30, type:'supergroup'}, from:{id:70}, date:now, message_id:1, is_topic_message:true, text:'hello'};
  const get = id => telegramJob({update_id:id, message:{...m, message_thread_id:id}}, c, now).route;
  assert.notEqual(routeKey(get(1)), routeKey(get(2)));
  const { store, api, posts } = harness();
  const route = {kind:'channel', chatId:'-40'};
  store.remember(routeKey(route), route, thread, '', now);
  await deliver(command('!tg-send Text'), c, store, api, null, now);
  assert.match(posts[0], /Only the configured Slack owner/);
});

test('ambiguous external write keeps its intent and is never sent twice', async () => {
  const {store} = harness(); let count = 0;
  const attempt = () => store.effect('send', async () => { count++; throw Error('connection_lost'); });
  await assert.rejects(attempt, /connection_lost/);
  await assert.rejects(attempt, /unconfirmed_effect/);
  assert.equal(count, 1);
});
