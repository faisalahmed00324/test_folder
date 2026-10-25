const { describe, test, expect } = require('@jest/globals');
const { createHash } = require('node:crypto');
const { createInviteLobby } = require('../../src/application/invite-lobby.ts');
const { invitationURL, parseInvitationFragment, seatClaimSchema } = require('../../src/protocol/invitations.ts');

const hash = token => createHash('sha256').update(token).digest('hex');
const invite = 'I'.repeat(43), token = 'A'.repeat(43), other = 'B'.repeat(43);
const request = (id = 1, seat = 0, secret = token) => ({ requestId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, seat, token: secret });
function harness(archive = []) {
  let clock = 1000, open = true;
  const records = [];
  const config = { matchId: 'invite-table', tokenHash: hash(invite), expiresAt: 10000 };
  const ports = { now: () => clock, newId: jest.fn(() => '00000000-0000-4000-8000-000000000099'), hash,
    equalHash: (a, b) => a === b, canClaim: () => open, append: jest.fn(async record => { records.push(record); }) };
  const lobby = createInviteLobby(config, ports, archive);
  return { lobby, ports, records, config, setTime: value => { clock = value; }, lock: () => { open = false; } };
}

describe('private invite links and request boundary', () => {
  test('keeps the invite in a fragment, rejects ambiguous fields and insecure destinations', () => {
    const url = invitationURL('https://cards.example/29_Card/index.html', 'wss://cards.example/29-card/ws', invite);
    expect(new URL(url).search).toBe('');
    expect(parseInvitationFragment(new URL(url).hash)).toEqual({ invite, server: 'wss://cards.example/29-card/ws' });
    for (const fragment of ['#invite=bad&server=invalid', `${new URL(url).hash}&invite=${invite}`, `${new URL(url).hash}&seat=3`, '#'.repeat(9000)]) {
      expect(parseInvitationFragment(fragment)).toBeNull();
    }
    expect(() => invitationURL('http://cards.example/29_Card/index.html', 'wss://cards.example/29-card/ws', invite)).toThrow('secure');
    expect(() => invitationURL('https://cards.example/29_Card/index.html', 'ws://cards.example/29-card/ws', invite)).toThrow();
    for (const raw of [{ ...request(), seat: 4 }, { ...request(), token: 'weak' }, { ...request(), actor: 'system' }, { ...request(), matchId: 'other' }]) {
      expect(seatClaimSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe('serialized durable invitation membership', () => {
  test('guests get availability only and claims become authoritative only after append completes', async () => {
    const h = harness(); await h.lobby.start(); await h.lobby.start();
    expect(h.records).toHaveLength(1);
    expect(h.lobby.authenticate(invite)).toMatchObject({ viewer: 'guest', matchId: 'invite-table' });
    expect(h.lobby.authenticate(token)).toBeNull();
    let release, entered;
    const appending = new Promise(resolve => { entered = resolve; });
    h.ports.append.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
    const first = h.lobby.claim(request()); await appending;
    const second = h.lobby.claim(request(2, 0, other));
    expect(h.lobby.getView().seats[0].occupied).toBe(false); expect(h.lobby.authenticate(token)).toBeNull();
    release();
    expect(await first).toEqual({ ok: true, seat: 0, expiresAt: 10000 });
    expect(await second).toEqual({ ok: false, code: 'SEAT_TAKEN' });
    expect(h.lobby.authenticate(token)).toMatchObject({ viewer: 0 });
    const view = h.lobby.getView();
    expect(Object.keys(view).sort()).toEqual(['canClaim', 'expiresAt', 'seats']);
    expect(JSON.stringify(view)).not.toContain(hash(token));
    expect(JSON.stringify(view)).not.toContain('membershipId');
    await h.lobby.shutdown();
  });
  test('retries bind the same seat and hash, never reveal a token, and cannot take new seats after play', async () => {
    const h = harness(); await h.lobby.start();
    const accepted = await h.lobby.claim(request());
    expect(await h.lobby.claim(request())).toEqual(accepted);
    expect(h.records).toHaveLength(2);
    expect(await h.lobby.claim(request(1, 1))).toMatchObject({ code: 'CLAIM_CONFLICT' });
    expect(await h.lobby.claim(request(1, 0, other))).toMatchObject({ code: 'CLAIM_CONFLICT' });
    expect(await h.lobby.claim(request(2, 1, token))).toMatchObject({ code: 'CLAIM_CONFLICT' });
    expect(await h.lobby.claim(request(2, 1, invite))).toMatchObject({ code: 'CLAIM_CONFLICT' });
    h.lock();
    expect(await h.lobby.claim(request())).toEqual(accepted);
    expect(await h.lobby.claim(request(2, 1, other))).toMatchObject({ code: 'TABLE_LOCKED' });
    expect(JSON.stringify(h.records)).not.toContain(token);
    await h.lobby.shutdown();
  });
  test('all four claims reserve the table and preserve roles/receipts through restart without minting another identity', async () => {
    const h = harness(); await h.lobby.start();
    const secrets = ['A', 'B', 'C', 'D'].map(char => char.repeat(43));
    for (const [seat, secret] of secrets.entries()) expect(await h.lobby.claim(request(seat + 1, seat, secret))).toMatchObject({ ok: true, seat });
    expect(h.lobby.getView().canClaim).toBe(false);
    const archive = structuredClone(h.records), membershipId = h.lobby.membershipId;
    await h.lobby.shutdown();
    const recovered = harness(archive); await recovered.lobby.start();
    expect(recovered.lobby.membershipId).toBe(membershipId);
    expect(recovered.ports.newId).not.toHaveBeenCalled(); expect(recovered.records).toEqual([]);
    for (const [seat, secret] of secrets.entries()) expect(recovered.lobby.authenticate(secret).viewer).toBe(seat);
    expect(await recovered.lobby.claim(request())).toMatchObject({ ok: true, seat: 0 });
    await recovered.lobby.shutdown();
  });
  test('expires shared and seat credentials together and fails closed on a backwards membership clock', async () => {
    const h = harness(); await h.lobby.start(); await h.lobby.claim(request());
    h.setTime(10000);
    expect(h.lobby.authenticate(invite)).toBeNull(); expect(h.lobby.authenticate(token)).toBeNull();
    expect(await h.lobby.claim(request(2, 1, other))).toMatchObject({ code: 'INVITE_EXPIRED' });
    h.setTime(999);
    expect(h.lobby.authenticate(token)).toBeNull();
    await expect(h.lobby.claim(request())).rejects.toThrow('clock');
    await h.lobby.shutdown();
  });
  test('rejects corrupt, duplicate and changed membership archives and never publishes a failed append', async () => {
    const h = harness(); await h.lobby.start(); await h.lobby.claim(request());
    await h.lobby.shutdown();
    for (const mutate of [
      records => { records[0].matchId = 'other'; }, records => { records[0].inviteHash = hash('different'); },
      records => { records[1].tokenHash = records[0].inviteHash; }, records => { records.push({ ...records[1] }); },
      records => { records.reverse(); },
    ]) {
      const archive = structuredClone(h.records); mutate(archive);
      const invalid = harness(archive); await expect(invalid.lobby.start()).rejects.toThrow(); await invalid.lobby.shutdown();
    }
    expect(() => harness([{}])).toThrow('Invalid membership journal');
    const failed = harness(); await failed.lobby.start();
    failed.ports.append.mockRejectedValueOnce(new Error('disk failed'));
    await expect(failed.lobby.claim(request())).rejects.toThrow('disk failed');
    expect(failed.lobby.authenticate(token)).toBeNull(); expect(() => failed.lobby.getView()).toThrow('unavailable');
    await failed.lobby.shutdown();
  });
});
