# {{APP_TITLE}}

{{IDEA}}

Built and verified by the da-prompt software factory. Stack: {{STACK_LABEL}}.
{{STACK_NOTES}}

## Quick start
```bash
npm install  # the pinned @appport/* packages (no other dependencies)
npm test     # HTTP API, UI and AppPort capability tests
npm start    # open http://localhost:3000
```

## Features
- Add items with a title and optional notes
- Mark items done / reopen them
- Filter by All, Open, Done
- Delete items
- Accessible, responsive UI with light and dark themes

## API
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health and item counts |
| GET | `/api/items` | List items |
| POST | `/api/items` | Create `{ title, notes?, done? }` |
| GET | `/api/items/:id` | Get one item |
| PATCH | `/api/items/:id` | Update any of `title`, `notes`, `done` |
| DELETE | `/api/items/:id` | Delete an item |

Invalid input returns `400 { "error": "..." }`; unknown ids return `404`.

## AppPort capabilities (for agents)
The same items are available as [AppPort](https://www.npmjs.com/package/@appport/core) capabilities, so an agent can
discover what the app can do and call it without reverse-engineering the HTTP API.

| Capability | Effect | Permission | What it does |
| --- | --- | --- | --- |
| `items.list` | read (`observation`) | `items.read` | List every item |
| `items.get` | read (`observation`) | `items.read` | Get one item by `id` (`NOT_FOUND` if missing) |
| `items.create` | write (`consequential`) | `items.write` | Create `{ title, notes?, done? }` |
| `items.update` | write (`consequential`) | `items.write` | Change `title`, `notes` or `done` of `id` |

- **Discover:** `GET /.well-known/appport` points to the manifest (`GET /appport/manifest`), which lists each capability
  with its input/output JSON Schema, effect and required permission.
- **Invoke:** `POST /appport` with an AppPort request envelope, or use the client:
  ```js
  import { AppPort } from '@appport/client';
  import { createHttpTransport } from '@appport/transport-http';
  const app = await AppPort.discover({ origin: 'http://localhost:3000', headers: { authorization: `Bearer ${process.env.APP_API_TOKEN}` }, transports: { http: (o) => createHttpTransport(o) } });
  await app.call('items.create', { title: 'Write the report' });
  ```
- **Authorization:** callers send `Authorization: Bearer <token>`. `APP_API_TOKEN` grants `items.read` and `items.write`,
  `APP_READ_TOKEN` (optional) only `items.read`. Without a token every capability is refused (`UNAUTHORIZED`); a read token
  calling a write gets `FORBIDDEN`. Tokens live in the server's environment only, never in the browser or in the manifest.
- **What is not exposed:** deleting items. `ItemStore.remove()` exists but is not a capability; add one in `src/appport.js`
  (with a permission) if agents should delete.
- **Retries:** `items.create` is not idempotent. If a call's answer is lost, list the items before trying again.
- **Authority:** capabilities call the same `ItemStore` as the HTTP API and the UI; there is no separate copy of the data.
  The HTTP API and UI themselves are unchanged and, as before, unauthenticated: deploy on trusted networks.

## Project layout
```
src/app.js      HTTP server, routing, static files
src/store.js    {{STORE_LINE}}
src/appport.js  AppPort capabilities over the store (what agents can discover and call)
src/auth.js     Who may call capabilities: tokens and permissions
public/         Web UI (HTML, CSS, JS)
test/           node:test suite
PRD.md          Product requirements
DEPLOY.md       Deployment guide
```

## Next steps
{{STORE_NEXT}}- Add accounts so multiple people can use one deployment
- Add due dates and sorting
