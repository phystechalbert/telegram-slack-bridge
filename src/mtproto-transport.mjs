import Long from 'long';
import { MemoryStorage } from '@mtcute/core';
import { BaseTelegramClient } from '@mtcute/core/client.js';
import { uploadFile } from '@mtcute/core/methods.js';
import { WebCryptoProvider, WebSocketTransport } from '@mtcute/web';
import wasm from '@mtcute/wasm/mtcute.wasm';

export class WorkersWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url, protocols) {
    super(); this.url = url; this.readyState = 0; this.binaryType = 'arraybuffer';
    const u = new URL(url);
    if (u.protocol !== 'wss:' || !['pluto', 'venus', 'aurora', 'vesta', 'flora'].some(n => u.hostname === n + '.web.telegram.org') || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/apiws') throw Error('user_sender_transport_destination');
    this.abort = new AbortController();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    fetch('https://' + u.host + u.pathname, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': Array.isArray(protocols) ? protocols.join(',') : protocols || 'binary' }, signal: this.abort.signal, redirect: 'manual' }).then(response => {
      if (response.status !== 101 || !response.webSocket) throw Error('user_sender_websocket_upgrade_failed');
      this.socket = response.webSocket; this.socket.binaryType = 'arraybuffer';
      this.socket.addEventListener('message', e => this.dispatchEvent(new MessageEvent('message', { data: e.data })));
      this.socket.addEventListener('close', e => {
        this.readyState = 3; this.resolveClosed();
        const event = new Event('close');
        Object.defineProperties(event, { code: { value: e.code }, reason: { value: e.reason }, wasClean: { value: e.wasClean } });
        this.dispatchEvent(event);
      });
      this.socket.addEventListener('error', () => { this.readyState = 3; this.resolveClosed(); this.dispatchEvent(new Event('error')); });
      this.socket.accept();
      if (this.readyState >= 2) { this.socket.close(1000, ''); this.resolveClosed(); return; }
      this.readyState = 1; this.dispatchEvent(new Event('open'));
    }).catch(() => { this.readyState = 3; this.resolveClosed(); this.dispatchEvent(new Event('error')); });
  }
  send(bytes) { if (this.readyState !== 1) throw Error('user_sender_websocket_not_open'); this.socket.send(bytes); }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    if (this.socket) this.socket.close(1000, '');
    else { this.abort.abort(); this.readyState = 3; this.resolveClosed(); }
  }
}

const platform = { beforeExit: () => () => {}, log: () => {}, getDefaultLogLevel: () => -1, getDeviceModel: () => 'Outbound relay', onNetworkChanged: () => () => {}, isOnline: () => true };
const options = { timeout: 20000, maxRetryCount: 0, floodSleepThreshold: 0 };

export async function createUserClient({ apiId, apiHash, session }) {
  const sockets = new Set();
  class TrackedSocket extends WorkersWebSocket { constructor(...args) { super(...args); sockets.add(this); } }
  const client = new BaseTelegramClient({ apiId, apiHash, storage: new MemoryStorage(), storageOptions: { saveInterval: 0 }, crypto: new WebCryptoProvider({ wasmInput: wasm }), platform, transport: new WebSocketTransport({ ws: TrackedSocket }), updates: false, disableUpdates: true, logLevel: -1 });
  const close = async () => {
    try { await client.destroy(); }
    finally {
      for (const socket of sockets) socket.close();
      let timer;
      try { await Promise.race([Promise.all([...sockets].map(s => s.closed)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('user_sender_cleanup_incomplete')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
  };
  try { await client.importSession(session); }
  catch (error) { await close(); throw error; }
  // Upload helpers call the underlying client directly, so bind the same retry policy there.
  const call = client.call.bind(client);
  client.call = (request, params = {}) => call(request, { ...params, ...options });
  return { call: request => client.call(request), zero: Long.ZERO, long: value => Long.fromString(value), upload: file => uploadFile(client, { file: file.bytes, fileName: file.name, fileMime: 'application/pdf', fileSize: file.bytes.length, partSize: 512, requestsPerConnection: 1 }), close };
}
