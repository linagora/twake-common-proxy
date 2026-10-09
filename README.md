# twake-common-proxy

Twake apps call this service instead of third-party APIs, so the provider never sees who the user is. The first module is GIF search with [KLIPY](https://docs.klipy.com).

## Run it

You need Node 22.

```bash
npm ci
cp config.example.yaml config.yaml
```

Point `config.yaml` at your homeserver or SSO, then start it with the secrets it reads from the environment:

```bash
PUBLIC_URL=http://localhost:8080 \
KLIPY_API_KEY=<KLIPY app key> \
MEDIA_SIGNING_KEY=$(openssl rand -hex 32) \
npm run dev
```

Run `npm run check` before you push. It's what CI runs.

## Release it

Push a `vX.Y.Z` tag. CI runs the checks and publishes `ghcr.io/linagora/twake-common-proxy:X.Y.Z`, with its digest in the run summary. The [Helm chart](https://ci.linagora.com/linagora/lrs/saas/tools/helm-charts/twake-common-proxy) deploys it.

KLIPY asks for written approval before a partner routes API calls or media through its own server ([integration requirements](https://docs.klipy.com/integration-requirements)). This service does both, so production needs that approval.

## Docs

- [Architecture](docs/architecture.md): how a request flows through the proxy, the privacy boundary, authentication and media links.
- [Dependencies](docs/dependencies.md): the services it calls, the libraries it runs on, and how it is built.
- [HTTP API](docs/api.md): every route, how callers authenticate, and what they get back.
- [Deploying](docs/deploy.md): what the proxy guarantees, its configuration, and what it reaches.
- [Development](docs/development.md): code layout, adding a provider or a module.
