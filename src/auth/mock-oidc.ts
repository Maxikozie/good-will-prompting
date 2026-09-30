import { z } from 'zod';
import { EnvJwt } from '../verification/tokens';

const identity = z.object({ sub: z.string().min(1).max(200) }).strict();
/** MOCK: local issuer factory for future demo integration, not a network endpoint or real OIDC provider.
 * Separate keys, issuer, audience and typ prevent mock tokens being used as verification tokens.
 * A production process must use its actual identity provider. */
export function createMockOidcIssuer(env: NodeJS.ProcessEnv = process.env) {
  const assertDevelopment = () => {
    if (process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production') throw new Error('Mock OIDC issuer is disabled in production');
  };
  assertDevelopment(); // Must run BEFORE parsing keys or constructing any issuer.
  const jwt = new EnvJwt(env, 'BRAIN_MOCK_OIDC', 'mock-oidc+jwt');
  return Object.freeze({
    async issue(subject: string) { assertDevelopment(); return jwt.sign(identity.parse({ sub: subject }), 15 * 60); },
    async verify(token: string) {
      assertDevelopment();
      const payload = await jwt.verify(token);
      return identity.parse({ sub: payload.sub });
    },
  });
}
