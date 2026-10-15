# {{APP_TITLE}}

{{IDEA}}

Built and verified by the da-prompt software factory. Stack: {{STACK_LABEL}}.

## Quick start
```bash
npm install  # the pinned @appport/* packages (no other dependencies)
npm test     # HTTP API, UI and AppPort capability tests
npm start    # open http://localhost:3000
```

## Features
- Search entries by text (name and description)
- Filter by category
- Read-only by design: the catalog's content is the seed in `src/store.js`
- Accessible, responsive UI with light and dark themes

## API
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health and entry counts |
| GET | `/api/entries?q=&category=` | Search entries (both parameters optional) |
| GET | `/api/entries/:id` | Get one entry |
| GET | `/api/categories` | List categories |

A query longer than 100 characters returns `400`; unknown ids return `404`; any other method returns `405`.

## AppPort capabilities (for agents)
The catalog is also available as [AppPort](https://www.npmjs.com/package/@appport/core) capabilities, so an agent can
discover what it offers and query it without reverse-engineering the HTTP API.

| Capability | Effect | Permission | What it does |
| --- | --- | --- | --- |
| `entries.search` | read (`observation`) | `entries.read` | Entries matching `query` and/or `category` |
| `entries.get` | read (`observation`) | `entries.read` | One entry by `id` (`NOT_FOUND` if missing) |
| `entries.categories` | read (`observation`) | `entries.read` | The categories, for filtering |

- **Discover:** `GET /.well-known/appport` points to the manifest (`GET /appport/manifest`), which lists each capability
  with its input/output JSON Schema, effect and required permission.
- **Invoke:** `POST /appport` with an AppPort request envelope, or use the client:
  ```js
  import { AppPort } from '@appport/client';
  import { createHttpTransport } from '@appport/transport-http';
  const app = await AppPort.discover({ origin: 'http://localhost:3000', headers: { authorization: `Bearer ${process.env.APP_API_TOKEN}` }, transports: { http: (o) => createHttpTransport(o) } });
  await app.call('entries.search', { query: 'guide' });
  ```
- **Authorization:** callers send `Authorization: Bearer <token>`; `APP_API_TOKEN` (or `APP_READ_TOKEN`) grants
  `entries.read`. Without a token every capability is refused (`UNAUTHORIZED`). Tokens live in the server's environment only.
- **No writes:** the catalog has no write operation, so it has no write capability. The HTTP API and UI remain public and
  read-only, as before.
- **Authority:** capabilities call the same `EntryStore` as the HTTP API and the UI; there is no separate copy of the data.

## Project layout
```
src/app.js      HTTP server, routing, static files
src/store.js    Read-only entry store and search rules (the single source of truth)
src/appport.js  AppPort capabilities over the store (what agents can discover and call)
src/auth.js     Who may call capabilities: tokens and permissions
public/         Web UI (HTML, CSS, JS)
test/           node:test suites
PRD.md          Product requirements
DEPLOY.md       Deployment guide
```

## Next steps
- Load entries from a file or database (implement the `EntryStore` methods)
- Add an editor role and write capabilities only once the application has write operations
- Add full-text ranking
