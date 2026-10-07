# Development

## How the code is laid out

- `src/server.ts` builds the Fastify app: CORS, rate limits, authentication, and the modules under `/v1`.
- `src/auth.ts` picks how a token is checked. `src/oidc.ts` checks SSO tokens. `src/identity.ts` holds what both share: the caller, the token cache, the 503 error.
- `src/upstream.ts` makes every outbound call and builds each request from scratch.
- `src/media.ts` signs media links and streams the files.
- `src/modules/<module>/` holds a module: its routes, its provider interface and its providers.

## Adding a provider

A provider is one file under `src/modules/<module>/providers/`. It exports a config schema and a factory that implements the module's provider interface (`src/modules/gif/types.ts` for GIFs), mapping the provider's JSON to the shared result type. Register it in the module's config schema and in its `create...Provider` switch.

## Adding a module

A module is a folder under `src/modules/` with a provider interface, a result type and a Fastify plugin for its routes. `src/server.ts` mounts it at `/v1/<module>` when its config says `enabled: true`.

## Tests

Tests call the app through `app.inject` and replace the internet with `fakeUpstream` from `tests/helpers.ts`, which records every outbound request, so a test can check exactly what leaves the proxy.
