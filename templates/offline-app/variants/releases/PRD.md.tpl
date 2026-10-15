# {{APP_TITLE}} — Product Requirements

## Problem and idea
{{IDEA}}

## Users
- **Publishers** release artifacts and sign them.
- **Consumers and agents** download artifacts and prove they are exactly what the publisher signed.

## Requirements (from the brief)
{{REQUIREMENTS}}

## Core user flows
1. **Publish** — an authorized agent publishes a version; the app signs it with the publisher key.
2. **Browse** — anyone lists releases and sees whether each one verifies.
3. **Verify** — anyone checks a release and artifact bytes against the publisher.

## Success criteria
- Every release is signed with the Distribution Protocol and verifies independently.
- Tampered manifests, wrong artifact bytes and releases signed by other keys are rejected.
- Automated tests cover the HTTP API, every AppPort capability and the signing rules, and pass with `npm test`.
- The app starts with `npm start`, honours `PORT`, and passes a health check once deployed.

## Out of scope for v1
Key rotation, multiple publishers.

## Risks and open questions
- The publisher key's custody is the operator's.
- Where the releases live is set by the stack: in memory by default, in FeltDB when FeltDB is selected.
