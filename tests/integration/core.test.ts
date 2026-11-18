import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import amqp from 'amqplib';
import { Core } from '../../src/application/core.js';
import { configuration } from '../../src/infra/config.js';
import { migrate } from '../../src/infra/migration.js';
import { PgStore } from '../../src/infra/postgres.js';
import { http } from '../../src/infra/http.js';
import { RabbitPublisher, bounded, type Publisher } from '../../src/infra/publisher.js';
import { OutboxWorker } from '../../src/infra/outbox.js';
import type { Event } from '../../src/domain/model.js';

test('real PostgreSQL HTTP transactions and RabbitMQ delivery/recovery', { timeout: 120000 }, async t => {
  // Never use a supplied operational schema. Leave this uniquely named schema intact.
  const schema = `core_it_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  process.env.CORE_DB_SCHEMA = schema;
  const { pool, rabbit } = configuration();
  const s = `"${schema}"`;
  const run = randomUUID().replaceAll('-', '');
  const topology = { exchange: `agrotrac.test.${run}`, liveQueue: `agrotrac.test.${run}.live`, auditQueue: `agrotrac.test.${run}.audit` };
  const publisher = new RabbitPublisher(rabbit, topology, 1500);
  let fault: string | undefined;
  const store = new PgStore(pool, schema, stage => { if (fault === stage) throw new Error('INJECTED_FAILURE'); });
  const app = http(new Core(store, { id: randomUUID, now: () => new Date().toISOString() }));
  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
  console.log(`INTEGRATION_SCHEMA=${schema}`);
  console.log(`INTEGRATION_TOPOLOGY=${JSON.stringify(topology)}`);
  try {
    const existing = await pool.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2");
    console.log(`INSPECTED_EXISTING_TABLES=${JSON.stringify(existing.rows)}`);
    await migrate(pool, schema, true);
    await assert.rejects(migrate(pool, schema, true), /brand new schema/);
    await migrate(pool, schema); // Idempotent recognized migration.
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    async function request(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
      const response = await fetch(`${url}/v1/core/${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const data = await response.json() as any;
      assert.match(response.headers.get('x-correlation-id')!, /^[0-9a-f-]{36}$/);
      if (response.status >= 400) { assert.equal(data.error.correlation_id, response.headers.get('x-correlation-id')); assert.ok(data.error.timestamp.endsWith('Z')); assert.match(response.headers.get('content-type')!, /application\/json/); }
      return { status: response.status, data };
    }
    async function silo(capacity = 10000, occupation = 0) {
      const result = await request('POST', 'silos', { codigo: randomUUID(), nome: 'Integração', tipo_grao: 'SOJA', capacidade_total_kg: capacity, ocupacao_fisica_kg: occupation }); assert.equal(result.status, 201); return result.data;
    }
    async function window(silo_id: string, capacity = 10000) {
      const result = await request('POST', 'windows', { silo_id, inicio_em: new Date(Date.now() + 60000).toISOString(), termino_em: new Date(Date.now() + 3600000).toISOString(), capacidade_maxima_kg: capacity }); assert.equal(result.status, 201); return result.data;
    }
    const input = (window_id: string, peso_estimado_kg = 2000) => ({ window_id, peso_estimado_kg, placa: 'ABC1D23', motorista_nome: 'Motorista Teste' });
    async function count(type: string, key: string, id: string) { return Number((await pool.query(`SELECT count(*) FROM ${s}.outbox_events WHERE type=$1 AND payload->'payload'->>$2=$3`, [type, key, id])).rows[0].count); }

    await t.test('10 HTTP calls of 2000 kg: exactly 5x201 and 5x409; persistent reads', async () => {
      const a = await silo(), w = await window(a.id);
      const results = await Promise.all(Array.from({ length: 10 }, () => request('POST', 'bookings', input(w.id))));
      assert.equal(results.filter(r => r.status === 201).length, 5);
      assert.equal(results.filter(r => r.status === 409 && r.data.error.code === 'CAPACITY_EXCEEDED').length, 5);
      const read = await request('GET', `windows/${w.id}`); assert.equal(read.data.saldo_reservado_kg, 10000); assert.equal(read.data.saldo_disponivel_kg, 0);
      assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, 10000);
      assert.equal(await count('agrotrac.core.booking.created', 'window_id', w.id), 5);
      const client = await pool.connect();
      try { const p1 = (await client.query('select pg_backend_pid() as pid')).rows[0].pid; const p2 = (await client.query(`select pg_backend_pid() as pid,saldo_reservado_kg from ${s}.silos where id=$1`, [a.id])).rows[0]; assert.equal(p1, p2.pid); assert.equal(Number(p2.saldo_reservado_kg), 10000); console.log(`PERSISTENT_CONNECTION_PID=${p1}`); } finally { client.release(); }
      console.log('CONCURRENCY=5x201,5x409; reserved=10000; booking.created=5');
    });
    await t.test('two windows compete for physical silo balance', async () => {
      const a = await silo(5000), w1 = await window(a.id), w2 = await window(a.id);
      const results = await Promise.all([request('POST', 'bookings', input(w1.id, 4000)), request('POST', 'bookings', input(w2.id, 3000))]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      assert.equal(results.find(r => r.status === 409)!.data.error.code, 'SILO_CAPACITY_EXCEEDED');
      const sum = Number((await pool.query(`SELECT sum(peso_estimado_kg) n FROM ${s}.bookings WHERE silo_id=$1 AND status='CONFIRMED'`, [a.id])).rows[0].n);
      assert.ok(sum === 3000 || sum === 4000); assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, sum);
      console.log(`TWO_WINDOWS=1x201,1x409; reserved=${sum}<=5000`);
    });
    await t.test('10 parallel cancellations refund exactly once', async () => {
      const a = await silo(), w = await window(a.id), b = await request('POST', 'bookings', input(w.id, 5000));
      assert.equal(b.status, 201);
      const results = await Promise.all(Array.from({ length: 10 }, () => request('DELETE', `bookings/${b.data.id}`)));
      assert.ok(results.every(r => r.status === 200 && r.data.status === 'CANCELLED'));
      assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, 0);
      assert.equal((await request('GET', `windows/${w.id}`)).data.saldo_reservado_kg, 0);
      assert.equal(await count('agrotrac.core.booking.cancelled', 'booking_id', b.data.id), 1);
      console.log('CANCELLATION=10x200; refund=5000; cancellation.events=1');
    });
    await t.test('rollback after both updates, booking and outbox insertion; cancellation rollback', async () => {
      const a = await silo(), w = await window(a.id);
      for (const stage of ['save:windows', 'insert:bookings', 'emit']) {
        fault = stage; const failed = await request('POST', 'bookings', input(w.id)); fault = undefined;
        assert.equal(failed.status, 500);
        assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, 0);
        assert.equal((await request('GET', `windows/${w.id}`)).data.saldo_reservado_kg, 0);
        assert.equal((await request('GET', `bookings?window_id=${w.id}`)).data.length, 0);
        assert.equal(await count('agrotrac.core.booking.created', 'window_id', w.id), 0);
      }
      const b = await request('POST', 'bookings', input(w.id)); assert.equal(b.status, 201);
      fault = 'emit'; assert.equal((await request('DELETE', `bookings/${b.data.id}`)).status, 500); fault = undefined;
      assert.equal((await request('GET', `bookings/${b.data.id}`)).data.status, 'CONFIRMED');
      assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, 2000);
      assert.equal(await count('agrotrac.core.booking.cancelled', 'booking_id', b.data.id), 0);
      console.log('ROLLBACK=3 create failpoints + cancellation after outbox; atomic state preserved');
    });
    await t.test('blocked/closed windows retain reservations; only new bookings denied', async () => {
      const a = await silo(), w = await window(a.id), b = await request('POST', 'bookings', input(w.id));
      assert.equal((await request('PATCH', `windows/${w.id}/status`, { status: 'BLOCKED', motivo: 'Manutenção' })).status, 200);
      assert.equal((await request('GET', `bookings/${b.data.id}`)).data.status, 'CONFIRMED');
      assert.equal((await request('POST', 'bookings', input(w.id))).data.error.code, 'WINDOW_NOT_OPEN');
      assert.equal((await request('GET', `silos/${a.id}`)).data.saldo_reservado_kg, 2000);
      assert.equal((await request('PATCH', `windows/${w.id}/status`, { status: 'CLOSED' })).status, 200);
      assert.equal((await request('PATCH', `windows/${w.id}/status`, { status: 'OPEN' })).status, 409);
      assert.equal((await request('DELETE', `bookings/${b.data.id}`)).status, 200);
    });
    await t.test('invalid HTTP data, unknown IDs, duplicates, UTC, safe maximum and SQL constraints', async () => {
      const a = await silo(10000, 1000), w = await window(a.id, 20000);
      for (const weight of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2000', null]) assert.equal((await request('POST', 'bookings', { ...input(w.id), peso_estimado_kg: weight })).status, 400);
      assert.equal((await request('POST', 'bookings', { ...input(w.id), placa: 'invalid' })).status, 400);
      assert.equal((await request('GET', 'silos/not-uuid')).status, 400);
      assert.equal((await request('GET', 'bookings?status=BAD')).status, 400);
      assert.equal((await request('GET', 'windows?silo_id=invalid')).status, 400);
      assert.equal((await request('POST', 'bookings', input(randomUUID()))).status, 404);
      assert.equal((await request('POST', 'windows', { silo_id: randomUUID(), inicio_em: w.inicio_em, termino_em: w.termino_em, capacidade_maxima_kg: 1 })).status, 404);
      assert.equal((await request('POST', 'silos', { codigo: a.codigo, nome: 'Duplicado', tipo_grao: 'SOJA', capacidade_total_kg: 1 })).status, 409);
      assert.equal((await request('POST', 'windows', { silo_id: a.id, inicio_em: '2026-02-30T00:00:00Z', termino_em: w.termino_em, capacidade_maxima_kg: 1 })).status, 400);
      assert.equal((await request('POST', 'windows', { silo_id: a.id, inicio_em: w.termino_em, termino_em: w.inicio_em, capacidade_maxima_kg: 1 })).status, 400);
      assert.equal((await request('POST', 'silos', { codigo: randomUUID(), nome: 'S', tipo_grao: 'S', capacidade_total_kg: 1, ocupacao_fisica_kg: 2 })).status, 400);
      assert.equal((await request('GET', 'silos', undefined, { 'x-correlation-id': 'bad' })).status, 400);
      const max = await silo(Number.MAX_SAFE_INTEGER); assert.equal((await request('GET', `silos/${max.id}`)).data.capacidade_total_kg, Number.MAX_SAFE_INTEGER);
      const negative = await pool.query(`UPDATE ${s}.silos SET saldo_reservado_kg=-1 WHERE id=$1`, [a.id]).then(() => '', e => e.code); assert.equal(negative, '23514');
      const oversized = await pool.query(`UPDATE ${s}.silos SET capacidade_total_kg=9007199254740992 WHERE id=$1`, [a.id]).then(() => '', e => e.code); assert.equal(oversized, '23514');
      const other = await silo(), b = await request('POST', 'bookings', input(w.id));
      assert.equal(await pool.query(`UPDATE ${s}.bookings SET silo_id=$1 WHERE id=$2`, [other.id, b.data.id]).then(() => '', e => e.code), '23503');
      assert.equal((await request('GET', `bookings?silo_id=${a.id}&window_id=${w.id}&status=CONFIRMED`)).data.length, 1);
      assert.equal((await request('POST', 'bookings', input(w.id, 8000))).status, 409);
      const expired = await request('POST', 'windows', { silo_id: a.id, inicio_em: new Date(Date.now() - 120000).toISOString(), termino_em: new Date(Date.now() - 60000).toISOString(), capacidade_maxima_kg: 1000 });
      assert.equal((await request('POST', 'bookings', input(expired.data.id, 1))).status, 422);
    });
    await t.test('real broker delivery uses isolated durable queues and persistent confirms', async () => {
      connection = await bounded(amqp.connect(rabbit, { timeout: 3000 }), 5000); connection.on('error', () => {});
      const channel = await connection.createChannel(); channel.on('error', () => {});
      const worker = new OutboxWorker(pool, schema, publisher);
      let dispatched = 0; while (await worker.dispatchOne()) { dispatched++; assert.ok(dispatched < 1000); }
      const rows = (await pool.query(`SELECT * FROM ${s}.outbox_events ORDER BY created_at,event_id`)).rows;
      assert.ok(rows.length > 0); assert.ok(rows.every(row => row.status === 'PUBLISHED'));
      const expected = new Set(rows.map(row => row.event_id));
      for (const queue of [topology.liveQueue, topology.auditQueue]) {
        const seen = new Set<string>();
        while (true) {
          const message = await channel.get(queue, { noAck: false }); if (!message) break;
          const event: Event = JSON.parse(message.content.toString());
          assert.ok(expected.has(event.event_id)); assert.equal(message.properties.deliveryMode, 2); assert.equal(message.properties.messageId, event.event_id);
          assert.equal(event.version, '1.0.0'); assert.ok(Number.isSafeInteger(event.payload.silo_version));
          if (event.payload.window_id) assert.ok(Number.isSafeInteger(event.payload.window_version));
          seen.add(event.event_id); channel.ack(message);
        }
        assert.deepEqual(seen, expected);
      }
      console.log(`BROKER_DELIVERY=${rows.length} outbox events; ${rows.length} received in each isolated queue`);
      // mandatory returns must fail even when the broker ACKs the publication.
      const event = rows[0].payload as Event;
      await assert.rejects(publisher.publish(event, 'unrouted.test.event'));
      await publisher.publish(event, event.type); // reconnect after delivery failure
      const replay = await channel.get(topology.liveQueue, { noAck: false }); assert.ok(replay); assert.equal(JSON.parse(replay.content.toString()).event_id, event.event_id); channel.ack(replay);
      const auditReplay = await channel.get(topology.auditQueue, { noAck: false }); assert.ok(auditReplay); channel.ack(auditReplay);
      // Audit also receives Live events, Live queue does not.
      await publisher.publish({ ...event, event_id: randomUUID(), type: 'agrotrac.live.test' }, 'agrotrac.live.test');
      assert.equal(await channel.get(topology.liveQueue, { noAck: false }), false);
      const liveEvent = await channel.get(topology.auditQueue, { noAck: false }); assert.ok(liveEvent); channel.ack(liveEvent);
      await channel.close();
    });
    await t.test('connection refusal retains PENDING with attempts/backoff; next real publisher recovers same ID', async () => {
      const a = await silo();
      const row = (await pool.query(`SELECT * FROM ${s}.outbox_events WHERE payload->'payload'->>'silo_id'=$1`, [a.id])).rows[0];
      // Exclusive unused local port simulates broker unavailability without stopping shared RabbitMQ.
      const unavailable = new RabbitPublisher('amqp://127.0.0.1:1', topology, 200);
      const failedWorker = new OutboxWorker(pool, schema, unavailable);
      await failedWorker.dispatchOne();
      let state = (await pool.query(`SELECT * FROM ${s}.outbox_events WHERE event_id=$1`, [row.event_id])).rows[0];
      assert.equal(state.status, 'PENDING'); assert.equal(state.attempts, 1); assert.ok(state.next_attempt_at > state.created_at);
      // Accelerate clock eligibility only for this new fixture, testing >5 failures without 60s sleeps.
      for (let i = 0; i < 5; i++) { await pool.query(`UPDATE ${s}.outbox_events SET next_attempt_at=now() WHERE event_id=$1`, [row.event_id]); await failedWorker.dispatchOne(); }
      state = (await pool.query(`SELECT * FROM ${s}.outbox_events WHERE event_id=$1`, [row.event_id])).rows[0]; assert.equal(state.attempts, 6); assert.equal(state.status, 'PENDING');
      await pool.query(`UPDATE ${s}.outbox_events SET next_attempt_at=now() WHERE event_id=$1`, [row.event_id]);
      await new OutboxWorker(pool, schema, publisher).dispatchOne();
      state = (await pool.query(`SELECT * FROM ${s}.outbox_events WHERE event_id=$1`, [row.event_id])).rows[0]; assert.equal(state.status, 'PUBLISHED'); assert.equal(state.attempts, 7);
      const channel = await connection!.createChannel();
      for (const queue of [topology.liveQueue, topology.auditQueue]) { const message = await channel.get(queue, { noAck: false }); assert.ok(message); assert.equal(JSON.parse(message.content.toString()).event_id, row.event_id); channel.ack(message); }
      await channel.close(); await unavailable.close();
      console.log('RECOVERY=6 failures retained PENDING; attempt 7 PUBLISHED; same event_id received twice (one per queue)');
    });
    await t.test('SKIP LOCKED holds a real SQL transaction; concurrent dispatchers do not duplicate', async () => {
      const a = await silo(), b = await silo();
      const ids = (await pool.query(`SELECT event_id FROM ${s}.outbox_events WHERE payload->'payload'->>'silo_id'=ANY($1::text[])`, [[a.id, b.id]])).rows.map(r => r.event_id);
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
      const held: Publisher = { publish: async (event, routing) => { entered(); await gate; await publisher.publish(event, routing); }, close: async () => {} };
      const first = new OutboxWorker(pool, schema, held).dispatchOne(); await started;
      assert.equal(await new OutboxWorker(pool, schema, publisher).dispatchOne(), true);
      assert.equal(await new OutboxWorker(pool, schema, publisher).dispatchOne(), false);
      release(); await first;
      const channel = await connection!.createChannel();
      for (const queue of [topology.liveQueue, topology.auditQueue]) { const seen: string[] = []; while (true) { const m = await channel.get(queue, { noAck: false }); if (!m) break; seen.push(JSON.parse(m.content.toString()).event_id); channel.ack(m); } assert.deepEqual(seen.sort(), ids.slice().sort()); }
      await channel.close();
    });
    await t.test('silent broker handshake timeout is bounded and connection is released', async () => {
      const sockets = new Set<net.Socket>();
      const blackhole = net.createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
      await new Promise<void>(resolve => blackhole.listen(0, '127.0.0.1', resolve));
      const address = blackhole.address() as net.AddressInfo;
      const silent = new RabbitPublisher(`amqp://127.0.0.1:${address.port}`, topology, 200);
      const sample = (await pool.query(`SELECT payload FROM ${s}.outbox_events LIMIT 1`)).rows[0].payload as Event;
      const start = Date.now();
      try { await assert.rejects(silent.publish(sample, sample.type)); assert.ok(Date.now() - start < 2000); }
      finally { await silent.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => blackhole.close(() => resolve())); }
      console.log(`HANDSHAKE_TIMEOUT_MS=${Date.now() - start}`);
    });
    await t.test('confirm timeout closes own socket and reconnects to real broker', async () => {
      const target = new URL(rabbit), sockets = new Set<net.Socket>(); let frozen = false;
      const relay = net.createServer(client => {
        const upstream = net.connect(Number(target.port || 5672), target.hostname);
        sockets.add(client); sockets.add(upstream);
        for (const socket of [client, upstream]) { socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
        client.on('data', bytes => { if (!frozen) upstream.write(bytes); });
        upstream.on('data', bytes => { if (!frozen) client.write(bytes); });
        client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
      });
      await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
      const proxyUrl = new URL(rabbit); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String((relay.address() as net.AddressInfo).port);
      const proxied = new RabbitPublisher(proxyUrl.toString(), topology, 300);
      const sample = (await pool.query(`SELECT payload FROM ${s}.outbox_events LIMIT 1`)).rows[0].payload as Event;
      const channel = await connection!.createChannel();
      try {
        await proxied.publish(sample, sample.type);
        for (const queue of [topology.liveQueue, topology.auditQueue]) { const m = await channel.get(queue, { noAck: false }); assert.ok(m); channel.ack(m); }
        frozen = true; const start = Date.now();
        await assert.rejects(proxied.publish(sample, sample.type)); assert.ok(Date.now() - start < 3000);
        frozen = false; await proxied.publish(sample, sample.type);
        for (const queue of [topology.liveQueue, topology.auditQueue]) { const m = await channel.get(queue, { noAck: false }); assert.ok(m); assert.equal(JSON.parse(m.content.toString()).event_id, sample.event_id); channel.ack(m); }
        console.log(`CONFIRM_TIMEOUT_AND_RECONNECT_MS=${Date.now() - start}`);
      } finally { await proxied.close(); await channel.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => relay.close(() => resolve())); }
    });
    console.log(`FINAL_COUNTS=${JSON.stringify((await pool.query(`SELECT (SELECT count(*) FROM ${s}.silos) silos,(SELECT count(*) FROM ${s}.windows) windows,(SELECT count(*) FROM ${s}.bookings) bookings,(SELECT count(*) FROM ${s}.outbox_events) outbox,(SELECT count(*) FROM ${s}.outbox_events WHERE status='PUBLISHED') published`)).rows[0])}`);
  } finally { await app.close(); await publisher.close(); if (connection) await connection.close(); await pool.end(); }
});
