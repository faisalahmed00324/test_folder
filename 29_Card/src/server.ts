import { randomBytes, createHash } from 'node:crypto';
import { readPrivateServerConfig, startPrivateServer } from './adapters/private-server';
import { parseArgs } from 'node:util';
import { invitationURL } from './protocol/invitations';

async function main() {
  if (process.argv[2] === '--generate-invite') {
    const args = parseArgs({ args: process.argv.slice(3), options: { page: { type: 'string' }, server: { type: 'string' } }, strict: true });
    const token = randomBytes(32).toString('base64url');
    const link = invitationURL(args.values.page ?? 'http://127.0.0.1:8765/29_Card/index.html',
      args.values.server ?? 'ws://127.0.0.1:8766/29-card/ws', token);
    console.log(JSON.stringify({ tokenHash: createHash('sha256').update(token).digest('hex'), link }));
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === '--generate-token') {
    const token = randomBytes(32).toString('base64url');
    console.log(JSON.stringify({ token, tokenHash: createHash('sha256').update(token).digest('hex') }));
    return;
  }
  const path = process.env.CARD29_CONFIG;
  if (!path) throw new Error('CARD29_CONFIG must name a private server configuration file');
  const host = await startPrivateServer(await readPrivateServerConfig(path), process.env.CARD29_JOURNAL_KEY,
    () => { console.error('29 Card runtime error; investigate private server logs/storage'); });
  console.log(`29 Card private WebSocket host: 127.0.0.1:${host.port}`);
  const stop = () => {
    void host.close().catch(() => { console.error('29 Card shutdown failed'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  void main().catch(() => { console.error('29 Card startup failed: check private configuration, key, port, and journal'); process.exitCode = 1; });
}
