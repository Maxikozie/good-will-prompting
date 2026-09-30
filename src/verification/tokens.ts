import { parseEnv } from '../../packages/brain/src/security/env';
import { parseJson } from '../../packages/brain/src/security/input';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';
import { Forbidden } from '../security/authorization';

export const MAX_LIFETIME_SECONDS = 72 * 60 * 60;
export const actionSchema = z.enum(['confirm', 'correct', 'rescope', 'reassign', 'reject']);
export const bindingSchema = z.object({
  factId: z.string().min(1).max(200), verifierId: z.string().min(1).max(200),
  allowedActions: z.array(actionSchema).min(1).max(5).refine((a) => new Set(a).size === a.length),
}).strict();
export type TokenBinding = z.infer<typeof bindingSchema>;
export interface VerifiedToken extends TokenBinding { jti: string; expiresAt: number }
const registered = z.object({
  iss: z.string().min(1), aud: z.string().min(1), jti: z.string().min(8).max(100),
  iat: z.number().int().nonnegative(), nbf: z.number().int().nonnegative(), exp: z.number().int().nonnegative(),
}).strict();

/** Fixed HS256, local key allowlist only. JOSE uses WebCrypto signature verification,
 * not a JavaScript secret/signature comparison. No URL/JWK from a token is trusted. */
export class EnvJwt {
  readonly #keys: Map<string, Uint8Array>;
  readonly #kid: string;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #type: string;
  constructor(env: NodeJS.ProcessEnv, prefix: string, type: string) {
    try {
      parseEnv(env);
      const keys = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string()).parse(parseJson(env[`${prefix}_KEYS`] ?? ''));
      this.#keys = new Map(Object.entries(keys).map(([kid, encoded]) => {
        const key = Buffer.from(encoded, 'base64');
        const canonical = Buffer.from(key.toString('base64'));
        const supplied = Buffer.from(encoded);
        if (key.length < 32 || canonical.length !== supplied.length || !timingSafeEqual(canonical, supplied)) throw new Error();
        return [kid, new Uint8Array(key)];
      }));
      this.#kid = z.string().min(1).parse(env[`${prefix}_ACTIVE_KID`]);
      this.#issuer = z.string().trim().min(1).parse(env[`${prefix}_ISSUER`]);
      this.#audience = z.string().trim().min(1).parse(env[`${prefix}_AUDIENCE`]);
      if (!this.#keys.has(this.#kid)) throw new Error();
      this.#type = type;
    } catch { throw new Error(`Invalid ${prefix} configuration: require issuer, audience, active kid and base64 keys of at least 32 bytes`); }
  }
  async sign(claims: JWTPayload, lifetime = MAX_LIFETIME_SECONDS): Promise<string> {
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_LIFETIME_SECONDS) throw new Error('Invalid token lifetime');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: this.#type, kid: this.#kid })
      .setIssuer(this.#issuer).setAudience(this.#audience).setJti(randomUUID())
      .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + lifetime).sign(this.#keys.get(this.#kid)!);
  }
  async verify(token: string): Promise<JWTPayload> {
    try {
      if (token.length > 8192) throw new Error();
      const { payload, protectedHeader } = await jwtVerify(token, (header) => {
        // Pin independently of the supplied header; no algorithm inference from a key.
        if (header.alg !== 'HS256' || header.typ !== this.#type || typeof header.kid !== 'string') throw new Error();
        if (Object.keys(header).some((k) => !['alg', 'typ', 'kid'].includes(k))) throw new Error();
        const key = this.#keys.get(header.kid);
        if (!key) throw new Error();
        return key;
      }, { algorithms: ['HS256'], issuer: this.#issuer, audience: this.#audience, typ: this.#type,
        requiredClaims: ['iss', 'aud', 'exp', 'nbf', 'iat', 'jti'], maxTokenAge: MAX_LIFETIME_SECONDS, clockTolerance: 0 });
      const p = registered.parse(Object.fromEntries(Object.keys(registered.shape).map((k) => [k, payload[k]])));
      if (protectedHeader.alg !== 'HS256' || p.exp <= p.iat || p.exp - p.iat > MAX_LIFETIME_SECONDS || p.nbf < p.iat || p.nbf >= p.exp) throw new Error();
      return payload;
    } catch { throw new Forbidden(); }
  }
}

/** Construct when the verification backend starts, before registering tools/listeners.
 * Missing/weak environment keys fail immediately; there is no default signing key. */
export class VerificationTokens {
  readonly #jwt: EnvJwt;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.#jwt = new EnvJwt(env, 'BRAIN_JWT', 'verification+jwt'); }
  async issue(binding: TokenBinding, lifetime = MAX_LIFETIME_SECONDS): Promise<string> {
    return this.#jwt.sign(bindingSchema.parse(binding), lifetime);
  }
  async verify(token: string): Promise<VerifiedToken> {
    try {
      const p = registered.extend(bindingSchema.shape).strict().parse(await this.#jwt.verify(token));
      return { jti: p.jti, factId: p.factId, verifierId: p.verifierId, allowedActions: p.allowedActions, expiresAt: p.exp * 1000 };
    } catch { throw new Forbidden(); }
  }
}
