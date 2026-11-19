import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {parseSchedule, scheduleCommand} from '../src/schedule.mjs';
const now = 1800000000;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(query, ...args) {
    if (!args.length && /^\s*CREATE/.test(query)) { db.exec(query); return []; }
    const statement = db.prepare(query);
    return /^\s*SELECT/.test(query) ? statement.all(...args) : (statement.run(...args), []);
  }};
  return {store: new Store(sql), db};
}
const job = (id, schedule, thread = '1.2') => ({id, user:'UABC', thread, schedule});
const create = (text='Hello', at=now+60) => ({action:'create',at,text});
test('parser requires offset, valid calendar values, bounded text, and exact controls',()=>{
  assert.deepEqual(parseSchedule('!tg-send-list'),{action:'list'});
  assert.deepEqual(parseSchedule('!tg-send-cancel s-ABCDEF12'),{action:'cancel',target:'S-abcdef12'});
  assert.deepEqual(parseSchedule('!tg-send-cancel ALL'),{action:'cancel',target:'all'});
  const a=parseSchedule('!tg-send-at 2027-01-15T08:00+08:00 Hello');
  assert.deepEqual(a,{action:'create',at:Date.UTC(2027,0,15)/1000,text:'Hello'});
  assert.equal(parseSchedule('!tg-send-at 2027-01-15T00:00:30Z Hello').at,Date.UTC(2027,0,15,0,0,30)/1000);
  for(const text of ['!tg-send-at 2027-02-30T00:00Z Hello','!tg-send-at 2027-01-15T00:00 Hello','!tg-send-at 2027-01-15T00:00+14:01 Hello','!tg-send-at 2027-01-15T24:00Z Hello','!tg-send-at 2027-01-15T00:00Z','!tg-send-list all','!tg-send-cancel bad']) assert.equal(parseSchedule(text).invalid,true,text);
  assert.equal(parseSchedule('hello'),null);
});
test('create writes one exact delayed outgoing job and retry is idempotent after due time',async()=>{
  const {store}=fixture(); const original=job('Ev1',create());
  const result=await scheduleCommand(store,original,now); assert.match(result,/S-[0-9a-f]{8}/);
  const row=store.one('SELECT * FROM jobs'); assert.equal(row.due,(now+60)*1000);
  assert.deepEqual(JSON.parse(row.body),{type:'outgoing',id:'scheduled:Ev1',user:'UABC',thread:'1.2',date:now+60,scheduled:true,text:'Hello',fileId:null});
  assert.equal(await scheduleCommand(store,original,now+3600),result);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM jobs').n,1);
});
test('time bounds and text-only requirement reject without delayed jobs',async()=>{
  const {store}=fixture();
  for(const [id,request,fileId] of [['past',create('a',now+59)],['far',create('b',now+72*3600+1)],['file',create('c'),'FABC']]) assert.match(await scheduleCommand(store,{...job(id,request),fileId},now),/rejected/);
  assert.equal(store.one('SELECT COUNT(*) AS n FROM jobs').n,0);
  assert.match(await scheduleCommand(store,job('max',create('max',now+72*3600)),now),/^Scheduled/);
});
test('duplicate normalized pending text is per thread; six-send cap applies',async()=>{
  const {store}=fixture();
  await scheduleCommand(store,job('a',create('Hello  world')),now);
  assert.match(await scheduleCommand(store,job('b',create('Hello\nworld')),now),/same text/);
  assert.match(await scheduleCommand(store,job('c',create('Hello world'),'2.3'),now),/^Scheduled/);
  for(let i=0;i<5;i++) assert.match(await scheduleCommand(store,job('fill'+i,create('text'+i)),now),/^Scheduled/);
  assert.match(await scheduleCommand(store,job('over',create('overflow')),now),/6 pending/);
});
test('global cap is 200 and list/cancel cannot affect another thread',async()=>{
  const {store}=fixture(); await scheduleCommand(store,job('seed',create()),now);
  for(let i=1;i<200;i++) {
    store.sql.exec('INSERT INTO jobs(id,body,due) VALUES(?,?,?)','seed'+i,'{}',(now+60)*1000);
    store.sql.exec('INSERT INTO scheduled_sends(event_id,job_id,short,thread,send_at,text_key,fingerprint) VALUES(?,?,?,?,?,?,?)','seed'+i,'seed'+i,'S-'+i.toString(16).padStart(8,'0'),'other'+i,now+60,'hash'+i,'fingerprint');
  }
  assert.match(await scheduleCommand(store,job('over',create('overflow'),'99.1'),now),/200 sends/);
  const listing=await scheduleCommand(store,job('list',{action:'list'}),now); assert.equal((listing.match(/S-/g)||[]).length,1);
  const short=store.one('SELECT short FROM scheduled_sends WHERE event_id=?','seed').short;
  assert.match(await scheduleCommand(store,job('wrong',{action:'cancel',target:short},'2.3'),now),/No cancellable/);
  assert.equal(store.one('SELECT status FROM jobs WHERE id=?','scheduled:seed').status,'queued');
});
test('cancel once, preserve taken jobs, replay does not cancel later additions',async()=>{
  const {store}=fixture(); await scheduleCommand(store,job('first',create('one')),now);
  await scheduleCommand(store,job('taken',create('two')),now); store.delay('scheduled:taken',(now+120)*1000);
  const cancellation=job('cancel',{action:'cancel',target:'all'});
  const result=await scheduleCommand(store,cancellation,now); assert.match(result,/^Cancelled/);
  assert.equal(store.one('SELECT status FROM jobs WHERE id=?','scheduled:first').status,'cancelled');
  assert.equal(store.one('SELECT status FROM jobs WHERE id=?','scheduled:taken').status,'queued');
  await scheduleCommand(store,job('later',create('three')),now);
  assert.equal(await scheduleCommand(store,cancellation,now),result);
  assert.equal(store.one('SELECT status FROM jobs WHERE id=?','scheduled:later').status,'queued');
});
test('conflicting event cannot replace its accepted schedule',async()=>{
  const {store}=fixture(); await scheduleCommand(store,job('same',create('one')),now);
  assert.match(await scheduleCommand(store,job('same',create('two')),now),/conflicting event/);
  assert.equal(JSON.parse(store.one('SELECT body FROM jobs').body).text,'one');
});
