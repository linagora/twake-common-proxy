import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const writeYaml = (content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'tcp-config-')), 'config.yaml');
  writeFileSync(path, content);
  return path;
};

const minimal = `
server:
  publicUrl: https://proxy.example.com
auth:
  services:
    - name: cozy-stack
      token: \${COZY_TOKEN}
media:
  signingKey: \${MEDIA_KEY}
modules:
  gif:
    provider: klipy
    providers:
      klipy:
        apiKey: \${KLIPY_API_KEY}
`;

const env = {
  COZY_TOKEN: 'c'.repeat(32),
  MEDIA_KEY: 'm'.repeat(32),
  KLIPY_API_KEY: 'klipy-key',
};

describe('loadConfig', () => {
  it('reads secrets from the environment and fills defaults', () => {
    const config = loadConfig(writeYaml(minimal), env);

    expect(config.auth.services).toEqual([{ name: 'cozy-stack', token: 'c'.repeat(32) }]);
    expect(config.media.signingKey).toBe('m'.repeat(32));
    expect(config.server.port).toBe(8080);
    expect(config.modules.gif).toMatchObject({
      enabled: true,
      provider: 'klipy',
      proxyMedia: true,
      providers: { klipy: { apiKey: 'klipy-key', contentFilter: 'medium' } },
    });
  });

  it('uses the ${VAR:-default} fallback when the variable is unset', () => {
    const path = writeYaml(`${minimal}\nlogLevel: \${LOG_LEVEL:-debug}\n`);

    expect(loadConfig(path, env).logLevel).toBe('debug');
  });

  it('names the missing setting when the active provider has no API key', () => {
    const path = writeYaml(minimal);
    const withoutKey = { ...env, KLIPY_API_KEY: undefined };

    expect(() => loadConfig(path, withoutKey)).toThrow(/modules\.gif\.providers\.klipy\.apiKey/);
  });

  it('rejects a module whose provider has no configuration block', () => {
    const path = writeYaml(minimal.replace('provider: klipy', 'provider: giphy'));

    expect(() => loadConfig(path, env)).toThrow(/modules\.gif\.provider/);
  });

  it('rejects a config with no way to authenticate callers', () => {
    const path = writeYaml(minimal.replace(/auth:[\s\S]*?(?=media:)/, ''));

    expect(() => loadConfig(path, env)).toThrow(/auth/);
  });
});
