import { randomUUID } from 'node:crypto';
import { Core } from './application/core.js';
import { configuration } from './infra/config.js';
import { http } from './infra/http.js';
import { PgStore } from './infra/postgres.js';
import { RabbitPublisher } from './infra/publisher.js';
import { OutboxWorker } from './infra/outbox.js';
const config = configuration();
const publisher = new RabbitPublisher(config.rabbit);
const worker = new OutboxWorker(config.pool, config.schema, publisher);
const app = http(new Core(new PgStore(config.pool, config.schema), { id: randomUUID, now: () => new Date().toISOString() }));
let stopping = false;
const polling = (async () => {
  while (!stopping) {
    try { if (await worker.dispatchOne()) continue; } catch { console.error('Outbox dispatch failed; retry scheduled.'); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
})();
async function close() { stopping = true; await app.close(); await polling; await publisher.close(); await config.pool.end(); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
try { await app.listen({ host: config.host, port: config.port }); console.log(`Core listening on ${config.host}:${config.port}`); }
catch { console.error('Core startup failed.'); await close(); process.exitCode = 1; }
