import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { createPinTables } from '../application/pin-tables';
import { createMatchActor } from '../application/match-actor';
import { PRESETS } from '../domain/presets';
import { createTableRequestSchema, joinTableRequestSchema } from '../protocol/private-tables';
import { nodeRuntime } from './node-runtime';
import { createWebSocketGateway } from './websocket-gateway';

const originSchema = z.url().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch { return false; }
}, 'Expected an HTTP(S) origin');
export const pinServerConfigSchema = z.strictObject({
  port: z.number().int().min(0).max(65535).default(8766),
  allowedOrigins: z.array(originSchema).min(1).max(20).default(['http://127.0.0.1:8765', 'http://localhost:8765']),
  maxTables: z.number().int().min(1).max(1000).default(100),
  lifetimeMs: z.number().int().min(1000).max(86_400_000).default(21_600_000),
  idleMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  requestsPerWindow: z.number().int().min(1).max(1000).default(30),
  rateWindowMs: z.number().int().min(1000).max(3_600_000).default(60_000),
  maxRateEntries: z.number().int().min(1).max(100_000).default(4096),
});

export function createPinTableService(server: import('node:http').Server, raw: unknown = {},
  onError: (error: unknown) => void = () => {}, sharedGateway?: ReturnType<typeof createWebSocketGateway>) {
  const config = pinServerConfigSchema.parse(raw);
  let closed = false;
  const origins = new Set(config.allowedOrigins);
  const rates = new Map<string, { since: number; count: number }>();
  const gateway = sharedGateway ?? createWebSocketGateway({ server, allowedOrigins: config.allowedOrigins, onError,
    authenticate: async token => tables.authenticate(token) });
  const tables = createPinTables(config, {
    now: nodeRuntime.now,
    newPin: () => String(randomInt(1_000_000)).padStart(6, '0'),
    newToken: () => randomBytes(32).toString('base64url'),
    newId: randomUUID,
    hash: token => createHash('sha256').update(token).digest('hex'),
    open: async matchId => {
      const actor = createMatchActor({ matchId, ruleset: PRESETS['29-standard'],
        lifecycle: { disconnectGraceMs: 60_000, abandonAfterMs: config.idleMs },
        table: { readyMs: 15_000, rematchMs: 20_000 } }, {
        ...nodeRuntime, append: async () => {},
        publish: (viewer, events) => gateway.publish(matchId, viewer, events), onError,
      });
      try {
        await actor.start();
        gateway.registerMatch(matchId, { ...actor, getHistory: () =>
          ({ entries: [], nextBefore: null, earliestAvailable: null, total: 0, truncated: false }) });
      } catch (error) { await actor.shutdown(); throw error; }
      return {
        hasConnections: () => {
          try { return actor.getView('spectator').seats?.some(seat => seat.connected) ?? false; }
          catch { return false; }
        },
        isClosed: () => {
          try { return actor.getView('spectator').table?.phase === 'CLOSED'; }
          catch { return true; }
        },
        close: async () => { gateway.unregisterMatch(matchId); await actor.shutdown(); },
      };
    },
  });
  function expireRates() {
    const now = Date.now();
    for (const [key, rate] of rates) if (now - rate.since >= config.rateWindowMs) rates.delete(key);
  }
  function allow(ip: string) {
    expireRates();
    let rate = rates.get(ip);
    if (!rate) {
      if (rates.size >= config.maxRateEntries) return false;
      rate = { since: Date.now(), count: 0 };
      rates.set(ip, rate);
    }
    return ++rate.count <= config.requestsPerWindow;
  }
  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) { request.resume(); json(response, 403, { error: 'Origin not allowed' }); return; }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    if (closed) { request.resume(); json(response, 503, { error: 'Service unavailable' }); return; }
    const isCreate = request.url === '/29-card/tables';
    const isJoin = request.url === '/29-card/tables/join';
    if (!isCreate && !isJoin) { request.resume(); json(response, 404, { error: 'Not found' }); return; }
    if (!allow(request.socket.remoteAddress ?? 'unknown')) {
      request.resume(); response.setHeader('Retry-After', String(Math.ceil(config.rateWindowMs / 1000)));
      json(response, 429, { error: 'Too many requests' }); return;
    }
    if (request.method === 'OPTIONS') {
      if (request.headers['access-control-request-method'] !== 'POST' ||
          (request.headers['access-control-request-headers'] ?? '').split(',').some(header =>
            header.trim() !== '' && header.trim().toLowerCase() !== 'content-type')) {
        request.resume(); json(response, 400, { error: 'Invalid preflight' }); return;
      }
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      response.end(); return;
    }
    if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        Number(request.headers['content-length'] ?? 0) > 1024 || request.headers['content-encoding']) {
      request.resume(); json(response, 400, { error: 'Invalid request' }); return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024) {
        response.setHeader('Connection', 'close');
        json(response, 400, { error: 'Request too large' }); return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { json(response, 400, { error: 'Invalid JSON' }); return; }
    let result;
    if (isCreate) {
      if (!createTableRequestSchema.safeParse(body).success) { json(response, 400, { error: 'Invalid request' }); return; }
      result = await tables.create();
    } else {
      const parsed = joinTableRequestSchema.safeParse(body);
      if (!parsed.success) { json(response, 400, { error: 'Invalid request' }); return; }
      result = await tables.join(parsed.data.pin);
    }
    if (result.ok) json(response, 200, result.credentials);
    else json(response, result.failure.status, { error: result.failure.error });
  }
  const timer = setInterval(() => {
    expireRates();
    void tables.sweep().catch(onError);
  }, 30_000);
  timer.unref();
  let closing: Promise<void> | undefined;
  return {
    authenticate: tables.authenticate,
    handle(request: IncomingMessage, response: ServerResponse) {
      void handle(request, response).catch(error => {
        onError(error);
        if (!response.headersSent && !response.destroyed) json(response, 503, { error: 'Service unavailable' });
        else response.destroy();
      });
    },
    close() {
      closed = true;
      closing ??= (async () => {
        clearInterval(timer); rates.clear();
        if (!sharedGateway) await gateway.close();
        await tables.close();
      })();
      return closing;
    },
  };
}

export async function startPinServer(raw: unknown = {}, onError: (error: unknown) => void = () => {}) {
  const config = pinServerConfigSchema.parse(raw);
  const server = createServer((request, response) => service.handle(request, response));
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.timeout = 10_000;
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  const service = createPinTableService(server, config, onError);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const stopped = server.listening ? new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      await service.close();
      server.closeAllConnections();
      await stopped;
    })();
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    return { port: (server.address() as import('node:net').AddressInfo).port, close };
  } catch (error) { await close(); throw error; }
}
