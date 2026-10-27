import { startPinServer } from './adapters/pin-server';

async function main() {
  if (process.argv.length > 2) throw new Error('This host accepts no command-line arguments');
  const host = await startPinServer({
    ...(process.env.CARD29_PORT ? { port: Number(process.env.CARD29_PORT) } : {}),
    ...(process.env.CARD29_ALLOWED_ORIGINS ? { allowedOrigins: process.env.CARD29_ALLOWED_ORIGINS.split(',').map(value => value.trim()) } : {}),
  }, () => { console.error('29 Card runtime error'); });
  console.log(`29 Card temporary PIN table host: http://127.0.0.1:${host.port}`);
  const stop = () => {
    void host.close().catch(() => { console.error('29 Card shutdown failed'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  void main().catch(() => { console.error('29 Card startup failed: check port and allowed origins'); process.exitCode = 1; });
}
