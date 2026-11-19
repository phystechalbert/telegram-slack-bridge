#!/usr/bin/env node
// Run locally by the account operator. Never run in the Worker or a build job.
import { readFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { MemoryStorage } from '@mtcute/core';
import { BaseTelegramClient } from '@mtcute/core/client.js';
import { sendCode, signIn, checkPassword } from '@mtcute/core/methods.js';
import { WebCryptoProvider, WebSocketTransport } from '@mtcute/web';

async function main() {
  const output = process.argv[2];
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const ownerId = Number(process.env.TELEGRAM_OWNER_ID);
  if (!output || !Number.isSafeInteger(apiId) || apiId < 1 || !/^[a-fA-F0-9]{32}$/.test(apiHash || '') || !Number.isSafeInteger(ownerId) || ownerId < 1) throw Error('configuration');
  if (!process.stdin.isTTY || typeof WebSocket !== 'function') throw Error('interactive_terminal_and_node22_required');
  // Refuse to overwrite a previous session; do not print it to the terminal.
  const destination = await open(output, 'wx', 0o600);
  let input, client;
  try {
    const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    input = createInterface({ input: process.stdin, output: silent, terminal: true });
    const ask = async prompt => { process.stderr.write(prompt); const answer = await input.question(''); process.stderr.write('\n'); return answer; };
    const wasmBytes = await readFile(fileURLToPath(import.meta.resolve('@mtcute/wasm/mtcute.wasm')));
    const wasmInput = await WebAssembly.compile(wasmBytes);
    const platform = { beforeExit: () => () => {}, log: () => {}, getDefaultLogLevel: () => -1, getDeviceModel: () => 'Outbound relay login', onNetworkChanged: () => () => {}, isOnline: () => true };
    client = new BaseTelegramClient({ apiId, apiHash, storage: new MemoryStorage(), crypto: new WebCryptoProvider({ wasmInput }), platform, transport: new WebSocketTransport({ ws: WebSocket }), updates: false, disableUpdates: true, logLevel: -1 });
    const call = client.call.bind(client);
    client.call = (request, params = {}) => call(request, { ...params, timeout: 20000, maxRetryCount: 0, floodSleepThreshold: 0 });
    const phone = (await ask('Phone number with country code (hidden): ')).trim();
    const sent = await sendCode(client, { phone });
    try { if (sent.phoneCodeHash) await signIn(client, { phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: (await ask('Telegram login code (hidden): ')).trim() }); }
    catch (error) {
      if (error?.text !== 'SESSION_PASSWORD_NEEDED') throw error;
      await checkPassword(client, await ask('Telegram two-step password (hidden): '));
    }
    const me = (await client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }))?.[0];
    if (me?._ !== 'user' || me.id !== ownerId || me.bot || me.deleted) throw Error('owner_mismatch');
    await destination.writeFile(await client.exportSession(), 'utf8');
    process.stderr.write('Session saved. Treat this file as an account credential; import it as TELEGRAM_USER_SESSION using your secret manager.\n');
  } finally { input?.close(); try { await destination.close(); } finally { await client?.destroy(); } }
}

main().catch(() => { process.stderr.write('Login failed. Check configuration, ownership and the local output file; no credentials were logged.\n'); process.exitCode = 1; });
