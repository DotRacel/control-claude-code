# AGENTS.md

Working notes for this repository — the reference docs and the local development loop.
`CLAUDE.md` is a symlink to this file.

## Docs

| | |
|---|---|
| [docs/INTERNALS.md](docs/INTERNALS.md) | injection, the control-plane, persistence, the CLI contract |
| [docs/INJECTION-DRIFT-RUNBOOK.md](docs/INJECTION-DRIFT-RUNBOOK.md) | when a claude release breaks a gate: diagnose, fix, and reprofile |
| [docs/MOBILE-UI.md](docs/MOBILE-UI.md) | the phone UI, and what an installed iOS app actually measured |
| [docs/DESKTOP-UI.md](docs/DESKTOP-UI.md) | the two-pane layout above 900px, and what the two platforms share |
| [docs/EVENTS.md](docs/EVENTS.md) | the data-plane wire contract every client builds on |
| [docs/HISTORY-EXPORT.md](docs/HISTORY-EXPORT.md) | exporting history out of a deployment, and auditing what the UI drops |

## Develop

```bash
npm install && npm test        # ~4s, needs no claude and no database
npm run db:up                  # postgres:17 — then DATABASE_URL=… npm test also covers persistence
cd web && npm install && npm run build
```

The CLI ships as one dependency-free `dist/cli.mjs` (`npm run build`); the server ships as the
container image. Tags drive releases: `npm version …` then `git push --follow-tags`.
