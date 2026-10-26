// E2E-only host. No test driver or scenario route is shipped in public assets.
const { createServer } = require('node:http');
const { createWebSocketGateway } = require('../../.build/29-card/adapters/websocket-gateway.js');
const { createMatchActor } = require('../../.build/29-card/application/match-actor.js');
const { createDeck } = require('../../.build/29-card/domain/cards.js');
const { PRESETS } = require('../../.build/29-card/domain/presets.js');
const { rulesetSchema } = require('../../.build/29-card/domain/ruleset.js');
const { nodeRuntime } = require('../../.build/29-card/adapters/node-runtime.js');
const { createInviteLobby } = require('../../.build/29-card/application/invite-lobby.js');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { startPinServer } = require('../../.build/29-card/adapters/pin-server.js');
let inviteLobby, inviteActor, pinHost;

const server = createServer((request, response) => {
  response.writeHead(request.url === '/healthz' ? 200 : 404); response.end('E2E host');
});
const gateway = createWebSocketGateway({ server, allowedOrigins: ['http://127.0.0.1:8878'],
  authenticate: async token => {
    const parsed = /^(play|watch|reconnect|rematch|social)-(0|1|2|3|spectator)$/.exec(token.replace(/_+$/, ''));
    return parsed ? { matchId: parsed[1], viewer: parsed[2] === 'spectator' ? 'spectator' : Number(parsed[2]) } :
      inviteLobby?.authenticate(token) ?? null;
  }, lobby: {
    getView: matchId => { if (matchId !== 'invites' || !inviteLobby) throw new Error('Lobby unavailable'); return inviteLobby.getView(); },
    claim: async (matchId, request) => { if (matchId !== 'invites' || !inviteLobby) throw new Error('Lobby unavailable'); return inviteLobby.claim(request); },
  }, limits: { messagesPerWindow: 2000 }, onError: error => console.error(error) });
const actors = [];
async function main() {
  pinHost = await startPinServer({ port: 8880, allowedOrigins: ['http://127.0.0.1:8878'], requestsPerWindow: 1000 },
    error => console.error(error));
  for (const matchId of ['play', 'watch', 'reconnect', 'rematch', 'social']) {
    const { maxBid, totalPoints, ...raw } = PRESETS['29-standard'];
    const ruleset = matchId === 'rematch' ? rulesetSchema.parse({ ...raw, matchEnd: { winAt: 1, loseAt: -1 } }) : PRESETS['29-standard'];
    const actor = createMatchActor({ matchId, ruleset, ...(['play', 'rematch'].includes(matchId) ? { table: {} } : {}),
      timers: { turnMs: 600000, doubleMs: 600000 }, lifecycle: { disconnectGraceMs: 600000, abandonAfterMs: 1200000 } },
    { ...nodeRuntime, firstDealer: () => 0, shuffle: createDeck, append: async () => {},
      publish: (viewer, events) => gateway.publish(matchId, viewer, events), onError: error => console.error(error) });
    actors.push(actor); gateway.registerMatch(matchId, actor); await actor.start();
  }
  inviteLobby = createInviteLobby({ matchId: 'invites', tokenHash: createHash('sha256').update('I'.repeat(43)).digest('hex'), expiresAt: Date.now() + 600000 }, {
    now: nodeRuntime.now, newId: randomUUID, hash: token => createHash('sha256').update(token).digest('hex'),
    equalHash: (a, b) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')),
    canClaim: () => Boolean(inviteActor && inviteActor.getView('spectator').version === 0), append: async () => {},
  });
  await inviteLobby.start();
  inviteActor = createMatchActor({ matchId: 'invites', ruleset: PRESETS['29-standard'], lifecycle: { disconnectGraceMs: 600000 },
    table: {}, timers: { turnMs: 600000 }, membershipId: inviteLobby.membershipId }, {
    ...nodeRuntime, firstDealer: () => 0, shuffle: createDeck, append: async () => {},
    publish: (viewer, events) => gateway.publish('invites', viewer, events), onError: error => console.error(error),
  });
  actors.push(inviteActor); gateway.registerMatch('invites', inviteActor); await inviteActor.start();
  server.listen(8879, '127.0.0.1');
}
process.once('SIGTERM', () => {
  void (async () => { await gateway.close(); await pinHost?.close(); await inviteLobby?.shutdown(); for (const actor of actors) await actor.shutdown(); server.close(); })();
});
void main().catch(error => { console.error(error); process.exitCode = 1; });
