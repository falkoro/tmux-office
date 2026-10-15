import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  accessCertsUrl,
  createAccessVerifier,
  type JwksDocument,
  keysFromJwks,
  verifyAccessJwt,
} from '../src/accessJwt.js';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-test';
const ISSUER = `https://${TEAM}`;

function keyPair(): { privateKey: KeyObject; jwks: JwksDocument; kid: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-key';
  return {
    privateKey,
    kid,
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
  };
}

function sign(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  kid = 'test-key',
  alg = 'RS256',
): string {
  const header = Buffer.from(JSON.stringify({ alg, kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: AUD, iss: ISSUER, exp: now + 60, nbf: now - 10, email: 'a@b', ...overrides };
}

describe('verifyAccessJwt', () => {
  const { privateKey, jwks } = keyPair();
  const keys = keysFromJwks(jwks);

  it('accepts a valid token and reads the email', () => {
    const token = sign(privateKey, payload());
    expect(verifyAccessJwt(token, { issuer: ISSUER, aud: AUD }, keys)).toEqual({
      ok: true,
      email: 'a@b',
    });
  });

  it('rejects a bad signature', () => {
    const other = keyPair();
    const token = sign(other.privateKey, payload());
    expect(verifyAccessJwt(token, { issuer: ISSUER, aud: AUD }, keys).ok).toBe(false);
  });

  it('rejects the wrong audience', () => {
    const token = sign(privateKey, payload({ aud: 'someone-else' }));
    const result = verifyAccessJwt(token, { issuer: ISSUER, aud: AUD }, keys);
    expect(result).toEqual({ ok: false, reason: 'aud' });
  });

  it('rejects an expired token outside the skew', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign(privateKey, payload({ exp: now - 120 }));
    const result = verifyAccessJwt(token, { issuer: ISSUER, aud: AUD }, keys);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects alg none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify(payload())).toString('base64url');
    const token = `${header}.${body}.`;
    expect(verifyAccessJwt(token, { issuer: ISSUER, aud: AUD }, keys).ok).toBe(false);
  });
});

describe('createAccessVerifier', () => {
  it('refetches once when the kid was not in the cached set', async () => {
    const first = keyPair();
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secondJwk = second.publicKey.export({ format: 'jwk' });
    const docs: JwksDocument[] = [
      first.jwks,
      { keys: [{ ...secondJwk, kid: 'later', alg: 'RS256', use: 'sig' }] },
    ];
    let fetches = 0;
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD }, async (url) => {
      expect(url).toBe(accessCertsUrl(TEAM));
      const doc = docs[fetches] ?? docs[0];
      fetches += 1;
      if (!doc) throw new Error('no doc');
      return doc;
    });
    const token = sign(second.privateKey, payload(), 'later');
    await expect(verifier.verify(token)).resolves.toEqual({ ok: true, email: 'a@b' });
    expect(fetches).toBe(2);
  });

  it('fails when the kid is still unknown after one refetch', async () => {
    const { privateKey, jwks } = keyPair();
    let fetches = 0;
    const verifier = createAccessVerifier(
      { teamDomain: `https://${TEAM}/`, aud: AUD },
      async () => {
        fetches += 1;
        return jwks;
      },
    );
    const token = sign(privateKey, payload(), 'missing');
    await expect(verifier.verify(token)).resolves.toEqual({ ok: false });
    expect(fetches).toBe(2);
  });

  it('caps unknown-kid refetches so made-up kids do not fan out to Cloudflare', async () => {
    const { privateKey, jwks } = keyPair();
    let fetches = 0;
    const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD }, async () => {
      fetches += 1;
      return jwks;
    });
    const tokens = Array.from({ length: 20 }, (_, i) => sign(privateKey, payload(), `junk-${i}`));
    await Promise.all(tokens.map((token) => verifier.verify(token)));
    for (const token of tokens) await verifier.verify(token);
    expect(fetches).toBe(2);
  });
});
