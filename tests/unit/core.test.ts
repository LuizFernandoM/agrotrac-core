import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Core } from '../../src/application/core.js';
import { kg, utc, uuid, type Result } from '../../src/domain/model.js';
import { MemoryStore } from '../support/memory.js';
import { mapRow } from '../../src/infra/postgres.js';
import { backoff } from '../../src/infra/outbox.js';
const cid = randomUUID();
export function value<T>(r: Result<T>): T { if (!r.ok) assert.fail(r.error.code); return r.value; }
const runtime = { id: randomUUID, now: () => new Date().toISOString() };
async function setup(hook?: (stage: string) => void) {
  const store = new MemoryStore(hook), core = new Core(store, runtime);
  const s = value(await core.createSilo({ codigo: randomUUID(), nome: 'Silo', tipo_grao: 'SOJA', capacidade_total_kg: 10000 }, cid));
  const w = value(await core.createWindow({ silo_id: s.id, inicio_em: new Date(Date.now() + 60000).toISOString(), termino_em: new Date(Date.now() + 3600000).toISOString(), capacidade_maxima_kg: 10000 }, cid));
  return { core, store, s, w, input: { window_id: w.id, placa: 'ABC1D23', motorista_nome: 'Motorista', peso_estimado_kg: 2000 } };
}
test('safe kg, canonical UUID and strict UTC validators', () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) assert.equal(kg(invalid), false);
  assert.equal(kg(0), true); assert.equal(kg(0, true), false); assert.equal(kg(Number.MAX_SAFE_INTEGER), true);
  assert.equal(uuid(randomUUID()), true); assert.equal(uuid(randomUUID().toUpperCase()), false);
  assert.equal(utc('2026-02-30T10:00:00Z'), false); assert.equal(utc('2026-11-15T10:00:00+00:00'), false); assert.equal(utc('2026-11-15T10:00:00Z'), true);
});
test('10 in-memory callers reserve exactly five and emit five versioned events', async () => {
  const { core, store, input, s } = await setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => core.createBooking(input, cid)));
  assert.equal(results.filter(r => r.ok).length, 5); assert.equal(results.filter(r => !r.ok).length, 5);
  assert.equal(store.state.silos.get(s.id)?.saldo_reservado_kg, 10000);
  const events = store.state.events.filter(e => e.type.endsWith('booking.created'));
  assert.equal(events.length, 5); assert.deepEqual(events.map(e => e.payload.silo_version), [2, 3, 4, 5, 6]);
});
test('blocking keeps confirmed booking; cancellation is idempotent under concurrency', async () => {
  const { core, store, input, s, w } = await setup(); const b = value(await core.createBooking(input, cid));
  value(await core.updateWindow(w.id, { status: 'BLOCKED' }, cid));
  assert.equal(value(await core.get('bookings', b.id)).status, 'CONFIRMED');
  const blocked = await core.createBooking(input, cid); assert.equal(blocked.ok, false);
  await Promise.all(Array.from({ length: 10 }, () => core.cancelBooking(b.id, {}, cid)));
  assert.equal(store.state.silos.get(s.id)?.saldo_reservado_kg, 0);
  assert.equal(store.state.events.filter(e => e.type.endsWith('booking.cancelled')).length, 1);
  value(await core.updateWindow(w.id, { status: 'CLOSED' }, cid));
  const reopened = await core.updateWindow(w.id, { status: 'OPEN' }, cid); assert.equal(reopened.ok, false);
});
test('domain rejects invalid input without HTTP and inactive/expired windows', async () => {
  const { core, store, input, s, w } = await setup();
  for (const peso_estimado_kg of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) assert.equal((await core.createBooking({ ...input, peso_estimado_kg }, cid)).ok, false);
  assert.equal((await core.createWindow({ silo_id: s.id, inicio_em: '2026-02-30T00:00:00Z', termino_em: '2026-03-05T00:00:00Z', capacidade_maxima_kg: 1 }, cid)).ok, false);
  assert.equal((await core.createWindow({ silo_id: s.id, inicio_em: '2030-01-01T00:00:00.999Z', termino_em: '2030-01-01T00:00:00Z', capacidade_maxima_kg: 1 }, cid)).ok, false);
  assert.equal((await core.createWindow({ silo_id: s.id, inicio_em: '2030-01-01T00:00:00Z', termino_em: '2030-01-01T00:00:00.001Z', capacidade_maxima_kg: 1 }, cid)).ok, true);
  store.state.silos.get(s.id)!.status = 'INACTIVE';
  const inactive = await core.createBooking(input, cid); assert.equal(!inactive.ok && inactive.error.code, 'SILO_INACTIVE');
  store.state.silos.get(s.id)!.status = 'ACTIVE'; store.state.windows.get(w.id)!.termino_em = '2020-01-01T00:00:00.000Z';
  const expired = await core.createBooking(input, cid); assert.equal(!expired.ok && expired.error.code, 'WINDOW_EXPIRED');
});
test('two windows share silo capacity, including blocked windows', async () => {
  const { core, input, s, w } = await setup();
  value(await core.createBooking({ ...input, peso_estimado_kg: 7000 }, cid));
  value(await core.updateWindow(w.id, { status: 'BLOCKED' }, cid));
  const second = value(await core.createWindow({ silo_id: s.id, inicio_em: w.inicio_em, termino_em: w.termino_em, capacidade_maxima_kg: 50000 }, cid));
  const denied = await core.createBooking({ ...input, window_id: second.id, peso_estimado_kg: 4000 }, cid);
  assert.equal(!denied.ok && denied.error.code, 'SILO_CAPACITY_EXCEEDED');
});
test('in-memory transaction rolls back after balances, booking and event', async () => {
  let armed = false; const { core, store, input } = await setup(stage => { if (armed && stage === 'emit') throw new Error('injected'); });
  const before = structuredClone(store.state); armed = true;
  await assert.rejects(core.createBooking(input, cid)); assert.deepEqual(store.state, before);
});
test('BIGINT mapper refuses precision loss; retry remains bounded beyond five attempts', () => {
  assert.equal(mapRow<{ peso_kg: number }>({ peso_kg: '9007199254740991' }).peso_kg, Number.MAX_SAFE_INTEGER);
  assert.throws(() => mapRow({ peso_kg: '9007199254740992' }));
  assert.equal(backoff(1), 250); assert.equal(backoff(100), 60000);
});
