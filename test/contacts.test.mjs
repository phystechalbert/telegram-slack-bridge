import test from 'node:test';
import assert from 'node:assert/strict';
import {parseContactCommand, contactWithClient, contactResult} from '../src/contacts.mjs';
const base = {_: 'user', id: 42, accessHash: '123', firstName: 'Old', lastName: '', username: 'target', contact: true};
function fake({user = base, fresh, resolvedId = 42, importId = 42, writeError = false, readbackBad = false, resolvePhone = true} = {}) {
  const calls = []; let reads = 0; let wrote = false; let first = user.firstName; let last = user.lastName;
  const client = {long: String, zero: '0', async call(r) {
    calls.push(r);
    if (r._ === 'contacts.resolveUsername') return {peer: {_: 'peerUser', userId: resolvedId}, users: [{...user, id: resolvedId}]};
    if (r._ === 'contacts.resolvePhone') return resolvePhone ? {peer: {_: 'peerUser', userId: resolvedId}, users: [{...user, id: resolvedId}]} : null;
    if (r._ === 'users.getUsers') {
      reads++;
      return [{...user, ...(fresh && reads >= 3 ? fresh : {}), ...(wrote ? {contact: true, firstName: readbackBad ? 'Wrong' : first, lastName: last} : {})}];
    }
    if (['contacts.addContact', 'contacts.importContacts'].includes(r._)) {
      if (writeError) throw new Error('secret session and phone');
      wrote = true; first = r.firstName ?? r.contacts[0].firstName; last = r.lastName ?? r.contacts[0].lastName;
      return r._ === 'contacts.addContact' ? {_: 'updates', updates: []} : {_: 'contacts.importedContacts', imported: [{userId: importId, clientId: r.contacts[0].clientId}], users: [{...user, id: importId}]};
    }
    throw new Error('unexpected ' + r._);
  }};
  return {client, calls};
}
const args = request => ({ownerId: '99', chatId: '42', username: 'target', request});
const rename = {action: 'rename', chatId: '42', firstName: 'New', lastName: '', expectedFirstName: 'Old', expectedLastName: ''};
const create = {action: 'create', chatId: '42', firstName: 'New', lastName: '', expectedUsername: '@target'};
const phone = {action: 'add_phone', phone: '+12025550114', firstName: 'New', lastName: ''};
const rejects = (promise, code) => assert.rejects(promise, error => error.message === code);
test('parses manual command formats and rejects invalid or unrelated input', () => {
  assert.deepEqual(parseContactCommand('!tg-contact-read 42'), {action: 'read', chatId: '42'});
  assert.deepEqual(parseContactCommand('!tg-contact-add '+JSON.stringify({chat_id:'42', first_name:'New', last_name:'', expected_username:'@target'})), create);
  assert.deepEqual(parseContactCommand('!tg-contact-rename '+JSON.stringify({chat_id:'42',first_name:'New',last_name:'',expected_first_name:'Old',expected_last_name:''})), rename);
  assert.deepEqual(parseContactCommand('!tg-contact-add-phone +12025550114 New'), phone);
  assert.deepEqual(parseContactCommand('!tg-contact-add-phone {"phone":"+1 (202) 555-0114","first_name":"New"}'), phone);
  for (const text of ['!tg-contact-read -1', '!tg-contact-rename {}', '!tg-contact-add-phone', '!tg-contact-add {"chat_id":"42","first_name":"New","extra":1}']) assert.deepEqual(parseContactCommand(text), {invalid:true});
  assert.equal(parseContactCommand('hello'), null);
});
test('read returns account saved name and username without inferring public name', async () => {
  const {client} = fake(); const result = await contactWithClient(client, args({action:'read',chatId:'42'}));
  assert.deepEqual(result.contact.saved_name, {first_name:'Old',last_name:''}); assert.equal(result.contact.username,'target'); assert.equal(result.contact.profile_name,undefined);
});
test('rename checks stale names twice and never writes wrong target', async () => {
  for (const setup of [{resolvedId: 43}, {user: {...base,firstName:'Changed'}}, {fresh: {firstName:'Changed'}}]) {
    const {client,calls} = fake(setup);
    await assert.rejects(contactWithClient(client,args(rename)));
    assert.equal(calls.some(r=>r._==='contacts.addContact'),false);
  }
  const {client,calls} = fake(); const result=await contactWithClient(client,args(rename));
  assert.equal(result.status,'verified'); assert.equal(result.contact.saved_name.first_name,'New');
  const write=calls.find(r=>r._==='contacts.addContact'); assert.equal(write.addPhonePrivacyException,false); assert.equal(write.id.userId,42);
});
test('create refuses saved contacts and username drift; verifies saved readback',async()=>{
  await rejects(contactWithClient(fake().client,args(create)),'contact_already_saved');
  await rejects(contactWithClient(fake({user:{...base,contact:false,username:'changed'}}).client,args(create)),'contact_username_changed_since_read');
  const {client,calls}=fake({user:{...base,contact:false}}); assert.equal((await contactWithClient(client,args(create))).status,'verified');
  assert.equal(calls.find(r=>r._==='contacts.addContact').phone,'');
});
test('mutation failures and failed readback are uncertain, never reported successful',async()=>{
  for (const setup of [{writeError:true},{readbackBad:true}]) await rejects(contactWithClient(fake(setup).client,args(rename)),'contact_outcome_unconfirmed');
});
test('phone addition uses verified exact peer; existing contact is never overwritten',async()=>{
  const saved=fake(); assert.equal((await contactWithClient(saved.client,args(phone))).status,'already_saved'); assert.equal(saved.calls.some(r=>r._==='contacts.importContacts'),false);
  const missing=fake({resolvePhone:false}); await rejects(contactWithClient(missing.client,args(phone)),'contact_phone_verification_required'); assert.equal(missing.calls.some(r=>r._==='contacts.importContacts'),false);
  const success=fake({user:{...base,contact:false}}); assert.equal((await contactWithClient(success.client,args(phone))).status,'verified');
  const write=success.calls.find(r=>r._==='contacts.addContact'); assert.equal(write.id.userId,42); assert.equal(write.phone,''); assert.equal(write.addPhonePrivacyException,false); assert.equal(success.calls.some(r=>r._==='contacts.importContacts'),false);
});
test('mismatched selected chat and invalid input fail before SDK calls',async()=>{
  const {client,calls}=fake(); await rejects(contactWithClient(client,{...args(rename),chatId:'43'}),'contact_target_mismatch'); assert.equal(calls.length,0);
  const result=JSON.parse(await contactResult({},args({invalid:true}))); assert.deepEqual(result,{ok:false,error:'contact_input_invalid'});
});
