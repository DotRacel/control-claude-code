/**
 * main.ts — the controller server process entry.
 *   PORT (default 8787), HOST (default 0.0.0.0 so a phone on the LAN can reach it),
 *   DATABASE_URL (PostgreSQL; see docker-compose.yml / .env.example).
 * Wires the bridge control-plane + data-plane (index.ts) to the browser channel
 * (web-channel.ts) and serves the SPA build (web/dist).
 *
 * Run: docker compose up -d db && DATABASE_URL=… node src/server/main.ts
 * Without DATABASE_URL it still runs, in memory, and says so — handy for a quick local try,
 * but nothing survives a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerServer, type ServerEvent } from './index.ts';
import { attachWebChannel } from './web-channel.ts';
import { createPool, ensureSchema, runBackfills, type Pool } from './db.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(here, '../../web/dist');
const ts = () => new Date().toISOString().slice(11, 23);
const short = (c?: string) => (c ? c.slice(0, 8) + '…' : '?');

async function main() {
  let web: ReturnType<typeof attachWebChannel> | null = null;

  let pool: Pool | undefined;
  if (process.env.DATABASE_URL) {
    pool = createPool(process.env.DATABASE_URL);
    await ensureSchema(pool);
    console.log(`${ts()} postgres connected, schema ensured`);
    // Deliberately NOT awaited: rows that predate a derived column get stamped in the background
    // while the server comes up, so an upgrade needs no manual step and a big table cannot delay
    // the first worker connecting. Silent unless there is something to do (db.ts, runBackfills).
    void runBackfills(pool, (m) => console.log(`${ts()} ${m}`));
  } else {
    console.log(`${ts()} ⚠️  DATABASE_URL not set — running IN MEMORY. Sessions and transcripts are lost on restart.`);
    console.log(`${ts()}    start the database with: docker compose up -d db   (see .env.example)`);
  }

  const server = await createControllerServer({
    port: PORT,
    host: HOST,
    staticDir,
    pool,
    onEvent: (e: ServerEvent) => {
      web?.handleEvent(e);
      if (e.type === 'env.register') console.log(`${ts()} env.register cred=${short(e.credential)} env=${e.envId} machine=${e.body?.machine_name ?? '?'} dir=${e.body?.directory ?? '?'}`);
      else if (e.type === 'session.create') console.log(`${ts()} session.create cred=${short(e.credential)} ses=${e.sessionId}`);
      else if (e.type === 'session.update') console.log(`${ts()} session.update ses=${e.sessionId}`);
      else if (e.type === 'session.delete') console.log(`${ts()} session.delete cred=${short(e.credential)} ses=${e.sessionId}`);
      else if (e.type === 'ws.connect') console.log(`${ts()} session online ses=${e.sessionId}`);
      else if (e.type === 'ws.close') console.log(`${ts()} session offline ses=${e.sessionId}`);
      else if (e.type === 'env.deregister') console.log(`${ts()} env.deregister env=${e.envId}`);
    },
  });

  web = attachWebChannel(server.server, server, server.store);

  const hasBuild = fs.existsSync(path.join(staticDir, 'index.html'));
  console.log(`${ts()} controller server listening on http://${HOST}:${PORT}`);
  if (pool) {
    const n = server.store.sessions.size;
    console.log(`${ts()} loaded ${n} session${n === 1 ? '' : 's'} and ${server.store.userCount} account${server.store.userCount === 1 ? '' : 's'} from postgres into the read cache`);
  }
  console.log(`${ts()} static SPA: ${hasBuild ? staticDir : 'NOT BUILT — run the web build (cd web && npm run build)'}`);
  // Without an invite code nobody can register, which on a first boot means nobody can use the
  // server at all — worth saying loudly rather than letting the web app 403 in the user's face.
  if (process.env.INVITE_CODE) console.log(`${ts()} registration OPEN — invite code is set (${process.env.INVITE_CODE.length} chars)`);
  else console.log(`${ts()} ⚠️  INVITE_CODE not set — registration is CLOSED. Start with: INVITE_CODE=<码> node src/server/main.ts`);
  if (!pool && !process.env.DATABASE_URL) console.log(`${ts()} ⚠️  accounts are in memory too — every registration is lost on restart`);
  console.log(`${ts()} clients connect with: control-claude --server http://<this-host>:${PORT}  (then log in), or the web app`);

  // Flush the batched last_activity bumps and close the pool instead of dropping them.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${ts()} shutting down…`);
    server.close();
    await server.store.close();
    await pool?.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => { console.error('[server] fatal:', e); process.exit(1); });
