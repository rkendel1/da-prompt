# {{APP_TITLE}}

{{IDEA}}

Built and verified by the da-prompt software factory. Stack: {{STACK_LABEL}}.

## Quick start
```bash
npm install  # the pinned packages of the selected stack
npm test     # HTTP API, AppPort capabilities and signing tests
PUBLISHER_PRIVATE_KEY="$(cat publisher.pem)" APP_API_TOKEN=change-me npm start   # http://localhost:3000
```
Create a publisher key once with `openssl genpkey -algorithm ed25519 -out publisher.pem` and keep it out of the repository.

## How releases are signed
Every release is signed with the [Distribution Protocol](https://www.npmjs.com/package/@distribution-protocol/protocol)
(`@distribution-protocol/protocol`): the manifest names the product, the publisher (`PUBLISHER_ID`) and the artifact's
SHA-256 digest and size, and is signed with the publisher's Ed25519 key (`PUBLISHER_PRIVATE_KEY`, `PUBLISHER_KEY_ID`). A
release is valid only if its signature verifies, it was signed by this publisher's key (the public key is shown at
`/api/health`), and, when bytes are given, they match the signed digest. Releases are immutable.

## API
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health, release counts and the publisher's public key |
| GET | `/api/releases` | List releases with their signed envelopes |
| GET | `/api/releases/:name/:version` | One release |
| GET | `/api/releases/:name/:version/artifact` | The artifact bytes |
| POST | `/api/verify` | Verify `{ release, content? }` (content base64): `{ valid, reason }` |

Publishing is not possible over plain HTTP: it goes through the authorized AppPort capability.

## AppPort capabilities (for agents)
| Capability | Effect | Permission | What it does |
| --- | --- | --- | --- |
| `releases.publish` | write (`consequential`) | `releases.write` | Sign and publish `{ name, version, artifactId?, mediaType?, content }` |
| `releases.list` | read (`observation`) | `releases.read` | Every release |
| `releases.get` | read (`observation`) | `releases.read` | One release (`NOT_FOUND` if missing) |
| `releases.verify` | read (`observation`) | `releases.read` | Verify a release and optional bytes |

- **Discover:** `GET /.well-known/appport` → `GET /appport/manifest`. **Invoke:** `POST /appport`, or `@appport/client`.
- **Authorization:** `Authorization: Bearer <token>`; `APP_API_TOKEN` grants read and write, `APP_READ_TOKEN` read only.
  Without a token every capability is refused.
- **Retries:** `releases.publish` is not idempotent; publishing the same version again is `CONFLICT`. If an answer is lost,
  call `releases.get` first.
- **Keys:** the private key never appears in a response, the manifest or the browser.

## Project layout
```
src/app.js       HTTP server, routing, static files
src/store.js     Releases (in memory) and their rules
src/signing.js   Signing and verification with @distribution-protocol/protocol
src/appport.js   AppPort capabilities over the store
src/auth.js      Who may call capabilities: tokens and permissions
test/            node:test suites (HTTP, AppPort, signing)
```

## Next steps
- Keep releases durably (select FeltDB in the stack)
- Publish the public key where consumers can pin it
