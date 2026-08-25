# control-claude-code

Drive the `claude` running in your terminal from your phone — **as a BYOK user**.

Anthropic gates Claude Code's Remote Control to OAuth (claude.ai subscription) logins; anyone on
`ANTHROPIC_API_KEY` or a relay endpoint is hard-refused. This tool injects the Bun-compiled
`claude` binary through its built-in inspector, neutralizes the OAuth-only gates, and re-hosts the
`/remote-control` control-plane on a server you can run yourself. Your **inference path is
untouched** — the model still answers through your own key and base URL.

Requires Node ≥ 22 and `claude` ≥ 2.1.229. Linux and macOS.

## Install

```bash
npm i -g control-claude-code     # or: npx control-claude-code
```

The package is `control-claude-code`; the command it installs is `control-claude`.

A launch asks npm for a newer version at most once a day, in the background, and the one-line
notice shows up on the *next* launch — claude's TUI owns the terminal, so anything we print has to
be on screen before it starts. `CCC_NO_UPDATE_CHECK=1` turns off both the notice and the request.

## Use

```bash
control-claude       # launches the normal claude TUI, with /rc enabled
```

Then type **`/rc`** in the TUI and the session shows up on your phone. Open the server URL there,
register (username + password + invite code), and you are talking to the same session — with
tool-use permission prompts, an output sheet, and the transcript.

First run asks which backend to use and logs you in; the answer lands in
`~/.config/control-claude-code/config.json` and later runs go straight to claude. The default
backend is `https://ccc.racel.dev`; `--login` reopens the picker to switch backend or account.

Anything the controller does not recognise is forwarded to claude verbatim:

```bash
control-claude --resume
control-claude -c --model opus "fix this bug"
control-claude -- --help          # everything after -- is claude's
control-claude --headless         # phone-only, no TUI
```

## Self-hosting the server (optional)

Most people do not need this — the default backend is hosted. To run your own:

```bash
INVITE_CODE=<码> docker compose up -d
```

That brings up the server on `:8787` with PostgreSQL behind it. The image is published at
`ghcr.io/dotracel/control-claude-code`. Without `INVITE_CODE` registration stays closed, which
on a fresh server means nobody can sign up at all. Point the CLI at it with
`control-claude --login`.

Sessions are not kept forever: one idle for **7 days** is deleted with its whole transcript
(`CCC_SESSION_TTL_DAYS`, `0` to keep everything). A session whose claude is still connected is
never swept. The web app can also delete one on the spot — the trash button on any offline row —
which is the same deletion, just asked for rather than waited for.

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

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, share it — for personal use, study
and research. Commercial use is not granted, and that includes use inside a company. `claude`
itself is Anthropic's, and this is a client for their product.
