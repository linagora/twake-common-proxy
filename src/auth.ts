import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export interface Principal {
  kind: 'service' | 'matrix';
  id: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const bearerToken = (header: string | undefined): string | undefined => {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
};

export const createAuthenticator = (config: Config['auth']) => {
  const services = config.services.map((s) => ({ name: s.name, digest: digest(s.token) }));

  return async (
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Principal | null> => {
    const token = bearerToken(
      typeof headers.authorization === 'string' ? headers.authorization : undefined,
    );
    if (!token) return null;

    const tokenDigest = digest(token);
    const service = services.find((s) => timingSafeEqual(s.digest, tokenDigest));
    if (service) return { kind: 'service', id: service.name };

    return null;
  };
};
