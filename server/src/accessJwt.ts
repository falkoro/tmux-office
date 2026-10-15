import { createPublicKey, createVerify, type KeyObject, webcrypto } from 'node:crypto';

import {
  ACCESS_JWKS_CACHE_MS,
  ACCESS_JWKS_MIN_REFETCH_MS,
  ACCESS_JWT_CLOCK_SKEW_SEC,
} from './constants.js';

export interface AccessJwtConfig {
  /** Team domain, with or without a leading `https://`. */
  teamDomain: string;
  aud: string;
}

export type AccessJwk = webcrypto.JsonWebKey & { kid?: string };

export interface JwksDocument {
  keys?: AccessJwk[];
  public_certs?: { kid?: string; cert?: string }[];
}

export type JwksFetcher = (url: string) => Promise<JwksDocument>;

export type AccessVerifyResult = { ok: true; email: string | null } | { ok: false; reason: string };

export interface AccessVerifier {
  verify(token: string | undefined): Promise<{ ok: true; email: string | null } | { ok: false }>;
}

export function accessTeamHost(teamDomain: string): string {
  return teamDomain
    .trim()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '');
}

export function accessIssuer(teamDomain: string): string {
  return `https://${accessTeamHost(teamDomain)}`;
}

export function accessCertsUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}

function decodeBase64Url(value: string): Buffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(segment).toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function keysFromJwks(doc: JwksDocument): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const jwk of doc.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      /* skip an unusable key */
    }
  }
  for (const cert of doc.public_certs ?? []) {
    if (!cert.kid || !cert.cert || keys.has(cert.kid)) continue;
    try {
      keys.set(cert.kid, createPublicKey(cert.cert));
    } catch {
      /* skip an unusable cert */
    }
  }
  return keys;
}

/**
 * Verify one Cloudflare Access JWT against already-loaded keys.
 * `unknown-kid` tells the caller to refetch JWKS once.
 */
export function verifyAccessJwt(
  token: string,
  config: { issuer: string; aud: string },
  keys: Map<string, KeyObject>,
  nowSec: number = Math.floor(Date.now() / 1000),
  skewSec: number = ACCESS_JWT_CLOCK_SKEW_SEC,
): AccessVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return { ok: false, reason: 'malformed' };

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || !payload) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, reason: 'kid' };
  }
  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: 'unknown-kid' };

  let signatureOk = false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    signatureOk = verifier.verify(key, decodeBase64Url(signaturePart));
  } catch {
    return { ok: false, reason: 'verify' };
  }
  if (!signatureOk) return { ok: false, reason: 'signature' };

  const aud = payload.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(config.aud)) return { ok: false, reason: 'aud' };
  if (payload.iss !== config.issuer) return { ok: false, reason: 'iss' };
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'exp' };
  if (payload.exp + skewSec < nowSec) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf - skewSec > nowSec) {
    return { ok: false, reason: 'nbf' };
  }
  return { ok: true, email: typeof payload.email === 'string' ? payload.email : null };
}

/**
 * Cached JWKS plus one refetch when the token names a kid we have not seen.
 */
export function createAccessVerifier(
  config: AccessJwtConfig,
  fetchJwks: JwksFetcher,
): AccessVerifier {
  const issuer = accessIssuer(config.teamDomain);
  const url = accessCertsUrl(config.teamDomain);
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let forcedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function load(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && keys.size > 0 && now - fetchedAt < ACCESS_JWKS_CACHE_MS) return;
    if (inflight) return inflight;
    // The kid comes from the request, so a stream of made-up kids must not
    // turn into a stream of fetches to the team domain.
    if (force) {
      if (now - forcedAt < ACCESS_JWKS_MIN_REFETCH_MS) return;
      forcedAt = now;
    }
    inflight = fetchJwks(url)
      .then((doc) => {
        keys = keysFromJwks(doc);
        fetchedAt = Date.now();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async verify(token) {
      if (!token) return { ok: false };
      try {
        await load(false);
      } catch {
        return { ok: false };
      }
      let result = verifyAccessJwt(token, { issuer, aud: config.aud }, keys);
      if (!result.ok && result.reason === 'unknown-kid') {
        try {
          await load(true);
        } catch {
          return { ok: false };
        }
        result = verifyAccessJwt(token, { issuer, aud: config.aud }, keys);
      }
      if (!result.ok) return { ok: false };
      return { ok: true, email: result.email };
    },
  };
}
