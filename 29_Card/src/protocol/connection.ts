export function validEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return raw.length <= 2048 && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/29-card/ws' &&
      (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
