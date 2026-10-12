# {{APP_TITLE}} — Product Requirements

## Problem and idea
{{IDEA}}

## Users
- **Primary:** an individual who wants a fast, no-signup place to capture and track items for this idea.
- **Secondary:** a small team sharing one deployed instance on an internal network.

## Requirements (from the brief)
{{REQUIREMENTS}}

## Core user flows
1. **Capture** — type a title (and optional notes), press Add; the item appears immediately.
2. **Track** — check an item off to mark it done; uncheck to reopen.
3. **Focus** — filter between All, Open and Done.
4. **Clean up** — delete an item that is no longer relevant.

## Success criteria
- A user can add, complete, filter and delete items in the browser with no errors.
- The JSON API (`/api/items`, `/api/health`) behaves as documented and rejects invalid input with `400`.
- Automated tests cover every endpoint and pass with `npm test`.
- The app starts with `npm start`, honours `PORT`, and passes a health check once deployed.

## Out of scope for v1
Accounts and authentication, persistent storage across restarts, multi-user sync.

## Risks and open questions
- In-memory storage resets on restart — acceptable for v1; a database adapter is the first follow-up.
- No auth: deploy only on trusted networks until accounts are added.
