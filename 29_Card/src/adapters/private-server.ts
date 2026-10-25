import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createMatchActor, restoreMatchActor } from '../application/match-actor';
import { PRESETS } from '../domain/presets';
import { seatSchema } from '../domain/seats';
import { lifecycleSettingsSchema } from '../application/seat-lifecycle';
import { tableSettingsSchema } from '../application/table-session';
import { openFileJournal } from './file-journal';
import { nodeRuntime } from './node-runtime';
import { createWebSocketGateway } from './websocket-gateway';
import { inviteConfigSchema } from '../protocol/invitations';
import { createInviteLobby, type MembershipRecord } from '../application/invite-lobby';

const originSchema = z.url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
}, 'Expected an HTTP(S) origin without a path');
const memberSchema = z.strictObject({
  viewer: z.union([seatSchema, z.literal('spectator')]),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive().safe(),
});
export const privateServerConfigSchema = z.strictObject({
  matchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  preset: z.enum(['29-standard', '29-simplified', '28-standard']).default('29-standard'),
  port: z.number().int().min(0).max(65535).default(8766),
  allowedOrigins: z.array(originSchema).min(1).max(20),
  journalPath: z.string().refine(isAbsolute, 'Journal path must be absolute'),
  members: z.array(memberSchema).min(4).max(5).optional(),
  invitation: inviteConfigSchema.extend({ journalPath: z.string().refine(isAbsolute, 'Membership journal path must be absolute') }).optional(),
  lifecycle: lifecycleSettingsSchema.default({ disconnectGraceMs: 60_000, abandonAfterMs: 600_000 }),
  table: z.union([tableSettingsSchema, z.literal(false)]).default({ readyMs: 15_000, rematchMs: 20_000 }),
}).superRefine((config, ctx) => {
  if (Boolean(config.members) === Boolean(config.invitation)) {
    ctx.addIssue({ code: 'custom', message: 'Configure either members or invitation, not both' });
  }
  if (config.invitation && config.table === false) ctx.addIssue({ code: 'custom', message: 'Invitation seating requires table readiness' });
  if (config.members && ([0, 1, 2, 3].some(seat => !config.members!.some(member => member.viewer === seat)) ||
       new Set(config.members.map(member => member.viewer)).size !== config.members.length ||
       new Set(config.members.map(member => member.tokenHash)).size !== config.members.length)) {
    ctx.addIssue({ code: 'custom', message: 'Require four unique seats and unique tokens, with at most one spectator' });
  }
});

export async function readPrivateServerConfig(filename: string): Promise<unknown> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) {
      throw new Error('Configuration must be a private regular file under 64 KiB');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

async function privateJournalPath(path: string) {
  const directory = await realpath(dirname(path));
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Journal directory must be private');
  const root = resolve(__dirname, '../../..');
  const relativeDirectory = relative(root, directory);
  if (relativeDirectory === '' || (!relativeDirectory.startsWith('..' + '/') && !isAbsolute(relativeDirectory))) {
    throw new Error('Journal directory must be outside the repository');
  }
  return join(directory, basename(path));
}

// One private table behind a TLS reverse proxy. Static credentials remain valid;
// optional invitation membership adds only an authenticated, invite-only lobby.
export async function startPrivateServer(raw: unknown, keyHex: unknown, onError: (error: unknown) => void) {
  const config = privateServerConfigSchema.parse(raw);
  const key = z.string().regex(/^[a-fA-F0-9]{64}$/).parse(keyHex);
  if (config.members?.some(member => member.expiresAt <= Date.now()) ||
      (config.invitation && config.invitation.expiresAt <= Date.now())) throw new Error('Membership already expired');
  const gamePath = await privateJournalPath(config.journalPath);
  const membershipPath = config.invitation ? await privateJournalPath(config.invitation.journalPath) : undefined;
  if (membershipPath && ([gamePath, `${gamePath}.lock`].includes(membershipPath) || `${membershipPath}.lock` === gamePath)) {
    throw new Error('Game and membership journals must have separate paths');
  }
  const journal = await openFileJournal(gamePath, Buffer.from(key, 'hex'), config.matchId);
  let membershipJournal: Awaited<ReturnType<typeof openFileJournal<MembershipRecord>>> | undefined;
  let inviteLobby: ReturnType<typeof createInviteLobby> | undefined;
  let actor: ReturnType<typeof createMatchActor> | undefined;
  try {
    if (config.invitation && membershipPath) {
      membershipJournal = await openFileJournal<MembershipRecord>(membershipPath, Buffer.from(key, 'hex'), `${config.matchId}:memberships`);
      if (membershipJournal.records.length === 0 && journal.records.length > 0) throw new Error('Membership journal missing for existing table');
      if (journal.records.length === 0 && membershipJournal.records.length > 1) throw new Error('Game journal missing for claimed invitation table');
      inviteLobby = createInviteLobby({ matchId: config.matchId, tokenHash: config.invitation.tokenHash, expiresAt: config.invitation.expiresAt }, {
        now: nodeRuntime.now, newId: randomUUID, hash: token => createHash('sha256').update(token).digest('hex'),
        equalHash: (a, b) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')),
        canClaim: () => {
          if (!actor) return false;
          const view = actor.getView('spectator');
          return view.version === 0 && ['WAITING', 'READY_CHECK'].includes(view.table?.phase ?? '');
        }, append: membershipJournal.append,
      }, membershipJournal.records);
      await inviteLobby.start();
    }
  } catch (error) { await inviteLobby?.shutdown(); await membershipJournal?.close(); await journal.close(); throw error; }
  let healthy = true;
  const reportError = (error: unknown) => { healthy = false; onError(error); };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: healthy }));
    } else { response.writeHead(404); response.end('Not found'); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxConnections = 100;
  const gateway = createWebSocketGateway({ server, allowedOrigins: config.allowedOrigins, onError: reportError,
    ...(inviteLobby ? { lobby: {
      getView: (matchId: string) => {
        if (matchId !== config.matchId) throw new Error('Lobby unavailable');
        return inviteLobby!.getView();
      },
      claim: async (matchId: string, request: Parameters<NonNullable<typeof inviteLobby>['claim']>[0]) => {
        if (matchId !== config.matchId) throw new Error('Lobby unavailable');
        return inviteLobby!.claim(request);
      },
    } } : {}),
    authenticate: async token => {
      if (inviteLobby) return inviteLobby.authenticate(token);
      const digest = createHash('sha256').update(token).digest();
      const member = config.members!.find(candidate => timingSafeEqual(digest, Buffer.from(candidate.tokenHash, 'hex')));
      return member && member.expiresAt > Date.now()
        ? { matchId: config.matchId, viewer: member.viewer, expiresAt: member.expiresAt } : null;
    },
  });
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      healthy = false;
      const serverClosed = server.listening
        ? new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
        : Promise.resolve();
      await gateway.close();
      await inviteLobby?.shutdown();
      await actor?.shutdown();
      await membershipJournal?.close();
      await journal.close();
      server.closeAllConnections();
      await serverClosed;
    })();
    return closing;
  }
  try {
    const ports = { ...nodeRuntime, append: journal.append,
      publish: (viewer: Parameters<typeof gateway.publish>[1], events: Parameters<typeof gateway.publish>[2]) =>
        gateway.publish(config.matchId, viewer, events), onError: reportError };
    if (journal.records.length > 0) {
      const metadata = z.object({ metadata: z.object({ matchId: z.string(), ruleset: z.unknown(),
         lifecycle: lifecycleSettingsSchema.optional(), table: tableSettingsSchema.optional(), membershipId: z.string().uuid().optional() }) }).parse(journal.records[0]).metadata;
      const { maxBid: _maxBid, totalPoints: _totalPoints, ...expectedRuleset } = PRESETS[config.preset];
      if (metadata.matchId !== config.matchId || !isDeepStrictEqual(metadata.ruleset, expectedRuleset)) {
        throw new Error('Journal does not match configured table');
      }
      if (!isDeepStrictEqual(metadata.lifecycle, config.lifecycle)) {
        throw new Error('Journal does not match configured lifecycle; legacy tables require a new match and journal');
      }
      if (!isDeepStrictEqual(metadata.table, config.table === false ? undefined : config.table)) {
        throw new Error('Journal does not match table coordination; legacy tables can explicitly use table: false');
      }
      if (metadata.membershipId !== inviteLobby?.membershipId) throw new Error('Journal does not match membership authority');
      actor = await restoreMatchActor(journal.records, ports);
    } else {
      actor = createMatchActor({ matchId: config.matchId, ruleset: PRESETS[config.preset], lifecycle: config.lifecycle,
        ...(config.table === false ? {} : { table: config.table }), ...(inviteLobby ? { membershipId: inviteLobby.membershipId } : {}) }, ports);
      await actor.start();
    }
    // Initial/recovery events are deliberately absent: first clients GET_VIEW.
    gateway.registerMatch(config.matchId, actor);
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
    return { port: (server.address() as import('node:net').AddressInfo).port, close };
  } catch (error) { await close(); throw error; }
}
