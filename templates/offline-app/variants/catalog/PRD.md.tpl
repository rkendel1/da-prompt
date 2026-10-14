# {{APP_TITLE}} — Product Requirements

## Problem and idea
{{IDEA}}

## Users
- **Primary:** people who need to look things up quickly in a curated reference.
- **Secondary:** agents that answer questions from the catalog through its AppPort capabilities.

## Requirements (from the brief)
{{REQUIREMENTS}}

## Core user flows
1. **Browse** — open the app and see every entry.
2. **Search** — type a word; entries whose name or description contains it are shown.
3. **Filter** — narrow the list to one category.

## Success criteria
- A user can search and filter entries in the browser with no errors.
- The JSON API (`/api/entries`, `/api/categories`, `/api/health`) behaves as documented and is read-only.
- Agents can discover and query the catalog through its AppPort capabilities (`/.well-known/appport`) with an authorized token.
- Automated tests cover every endpoint and capability and pass with `npm test`.
- The app starts with `npm start`, honours `PORT`, and passes a health check once deployed.

## Out of scope for v1
Editing entries, accounts, ranking.

## Risks and open questions
- The content is a seed in code; a data file or database is the first follow-up.
- Where should entries come from in production?
