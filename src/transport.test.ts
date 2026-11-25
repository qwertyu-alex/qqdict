import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import tls from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import type { CodexHarness } from './harness';
import { DictationTransport, type DictationEvent } from './transport';

type SentEvent = { type: string; audio?: string };
const maximumAudioBytes = 24_000 * 2 * 300;

function activeTransport(audioBytes: number) {
  const sent: SentEvent[] = [];
  const transport = new DictationTransport({} as CodexHarness, () => {});
  const internal = transport as unknown as {
    audioBytes: number;
    complete(): void;
  };
  Object.assign(transport, {
    started: true,
    audioBytes,
    socket: {
      readyState: WebSocket.OPEN,
      send: (message: string) => { sent.push(JSON.parse(message) as SentEvent); },
      close: () => {},
    },
  });
  return { transport, internal, sent };
}

test('stop appends one second of generated silence before session.close exactly once', async () => {
  const { transport, internal, sent } = activeTransport(24_000);
  const first = transport.stop();
  assert.equal(transport.stop(), first);
  assert.deepEqual(sent.map(event => event.type), ['audio.append', 'session.close']);
  const silence = Buffer.from(sent[0]!.audio!, 'base64');
  assert.equal(silence.length, 48_000);
  assert.equal(silence.every(byte => byte === 0), true);
  assert.equal(internal.audioBytes, 72_000);
  internal.complete();
  assert.equal(await first, '');
});

test('stop does not add generated audio to an empty session', async () => {
  const { transport, internal, sent } = activeTransport(0);
  const result = transport.stop();
  assert.deepEqual(sent, [{ type: 'session.close' }]);
  assert.equal(internal.audioBytes, 0);
  internal.complete();
  assert.equal(await result, '');
});

test('endpoint silence consumes only the remaining five-minute budget', async () => {
  for (const remainingBytes of [4_800, 2, 0]) {
    const { transport, internal, sent } = activeTransport(maximumAudioBytes - remainingBytes);
    const result = transport.stop();
    assert.equal(internal.audioBytes, maximumAudioBytes);
    assert.equal(sent.at(-1)?.type, 'session.close');
    const appended = sent.filter(event => event.type === 'audio.append');
    assert.equal(appended.length, remainingBytes ? 1 : 0);
    if (remainingBytes) assert.equal(Buffer.from(appended[0]!.audio!, 'base64').length, remainingBytes);
    internal.complete();
    await result;
  }
});

// Accepts only `acceptedToken`. The transport always dials wss, so its TLS
// connection is routed to this local plain-text server for the test.
async function dictationServer(t: TestContext, acceptedToken: string) {
  const tokens: string[] = [];
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    tokens.push(token);
    if (token !== acceptedToken) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => ws.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'session.start') ws.send(JSON.stringify({ type: 'session.started' }));
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const connect = tls.connect;
  tls.connect = (() => net.connect(port, '127.0.0.1')) as unknown as typeof tls.connect;
  t.after(() => {
    tls.connect = connect;
    for (const client of sockets.clients) client.terminate();
    server.closeAllConnections();
    server.close();
  });
  return tokens;
}

function recoveringHarness(tokens: { first: string; reloaded: string; refreshed: string }) {
  const calls: string[] = [];
  let reloaded = false;
  const harness = {
    async getAuth(refreshToken = false) {
      calls.push(refreshToken ? 'refresh' : 'read');
      const token = refreshToken ? tokens.refreshed : reloaded ? tokens.reloaded : tokens.first;
      return { token, label: 'Codex sign-in found', backendOrigin: 'https://chatgpt.com' };
    },
    dispose() { calls.push('dispose'); reloaded = true; },
  } as unknown as CodexHarness;
  return { harness, calls };
}

test('a rejected sign-in is reloaded from a fresh harness before the take fails', async (t) => {
  const tokens = await dictationServer(t, 'current');
  const { harness, calls } = recoveringHarness({ first: 'stale', reloaded: 'current', refreshed: 'refreshed' });
  const events: DictationEvent[] = [];
  const transport = new DictationTransport(harness, (event) => events.push(event));
  await transport.start();
  transport.cancel();
  assert.deepEqual(calls, ['read', 'dispose', 'read']);
  assert.deepEqual(tokens, ['stale', 'current']);
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('a sign-in still rejected after reloading is refreshed through Codex', async (t) => {
  const tokens = await dictationServer(t, 'refreshed');
  const { harness, calls } = recoveringHarness({ first: 'stale', reloaded: 'stale', refreshed: 'refreshed' });
  const events: DictationEvent[] = [];
  const transport = new DictationTransport(harness, (event) => events.push(event));
  await transport.start();
  transport.cancel();
  assert.deepEqual(calls, ['read', 'dispose', 'read', 'refresh']);
  assert.deepEqual(tokens, ['stale', 'stale', 'refreshed']);
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('a sign-in rejected after refreshing fails the take once', async (t) => {
  const tokens = await dictationServer(t, 'never');
  const { harness, calls } = recoveringHarness({ first: 'stale', reloaded: 'stale', refreshed: 'revoked' });
  const events: DictationEvent[] = [];
  const transport = new DictationTransport(harness, (event) => events.push(event));
  await assert.rejects(transport.start(), { message: 'HTTP 401. Your existing Codex sign-in was not accepted.' });
  assert.deepEqual(calls, ['read', 'dispose', 'read', 'refresh']);
  assert.deepEqual(tokens, ['stale', 'stale', 'revoked']);
  assert.deepEqual(events.filter(event => event.type === 'error'), [{ type: 'error', text: 'HTTP 401. Your existing Codex sign-in was not accepted.' }]);
});
