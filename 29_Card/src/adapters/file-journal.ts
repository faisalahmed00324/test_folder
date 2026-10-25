import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { JournalRecord } from '../application/match-actor';

const envelopeSchema = z.strictObject({
  format: z.literal(1), index: z.number().int().nonnegative(),
  previous: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().regex(/^(?:[a-f0-9]{2})+$/),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// One local writer only. Keys belong in a secret manager/KMS, never in this file.
// A failed append is ambiguous: close and recover before accepting more commands.
export async function openFileJournal<Record = JournalRecord>(path: string, encryptionKey: Uint8Array, matchId: string) {
  if (encryptionKey.length !== 32 || !matchId) throw new Error('Invalid journal configuration');
  const key = Buffer.from(encryptionKey);
  const filename = resolve(path);
  const lockPath = `${filename}.lock`;
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Journal must be a private regular file');
    const directory = await open(dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    const text = await file.readFile('utf8');
    const records: unknown[] = [];
    let previous = '0'.repeat(64);
    let committedBytes = 0;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length - 1; index++) {
      const line = lines[index];
      const parsed = envelopeSchema.safeParse(JSON.parse(line));
      if (!parsed.success || parsed.data.index !== index || parsed.data.previous !== previous) throw new Error('Invalid journal chain');
      const envelope = parsed.data;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'));
      decipher.setAAD(Buffer.from(JSON.stringify([1, matchId, index, previous])));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]);
      records.push(JSON.parse(plaintext.toString('utf8')));
      previous = hash(line);
      committedBytes += Buffer.byteLength(line) + 1;
    }
    // A crash may leave an unacknowledged partial last write. Never skip a corrupt
    // complete record; only discard bytes after the final newline commit marker.
    if (lines[lines.length - 1] !== '') { await file.truncate(committedBytes); await file.sync(); }
    let index = records.length;
    let closed = false;
    let failed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const handle = file;
    return {
      records,
      append(record: Record) {
        // Capture before entering the queue so callers cannot mutate pending data.
        const plaintext = JSON.stringify(record);
        const work = tail.then(async () => {
          if (closed || failed) throw new Error('Journal unavailable');
          try {
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, nonce);
            cipher.setAAD(Buffer.from(JSON.stringify([1, matchId, index, previous])));
            const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            const line = JSON.stringify({ format: 1, index, previous, nonce: nonce.toString('hex'),
              tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
            await handle.writeFile(`${line}\n`, 'utf8');
            await handle.sync();
            previous = hash(line); index++;
          } catch (error) { failed = true; throw error; }
        });
        tail = work.catch(() => undefined);
        return work;
      },
      async close() {
        if (closed) return;
        closed = true;
        await tail;
        await handle.close(); await lock.close(); await unlink(lockPath);
        key.fill(0);
      },
    };
  } catch (error) {
    await file?.close(); await lock.close(); await unlink(lockPath); key.fill(0);
    throw error;
  }
}
