# {{APP_TITLE}}

{{IDEA}}

Built and verified by the da-prompt software factory.

## Quick start
```bash
npm test     # 6 tests, no dependencies to install
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

## Project layout
```
src/app.js      HTTP server, routing, static files
src/store.js    In-memory store with validation
public/         Web UI (HTML, CSS, JS)
test/           node:test suite
PRD.md          Product requirements
DEPLOY.md       Deployment guide
```

## Next steps
- Persist items in SQLite or Postgres (implement the `ItemStore` methods)
- Add accounts so multiple people can use one deployment
- Add due dates and sorting
