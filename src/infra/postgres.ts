import type { Pool, PoolClient } from 'pg';
import type { Repository, Store } from '../application/ports.js';
import { fail, type Event, type Result, type Table, type Tables } from '../domain/model.js';
export function schemaName(schema: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || schema === 'public' || schema === 'information_schema' || schema.startsWith('pg_')) throw new Error('Unsafe schema');
  return `"${schema}"`;
}
export function mapRow<T>(row: Record<string, unknown>): T {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) mapped[key] = value.toISOString();
    else if ((key.endsWith('_kg') || key === 'version') && typeof value === 'string') {
      const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('Unsafe database integer'); mapped[key] = n;
    } else mapped[key] = value;
  }
  return mapped as T;
}
export class PgRepository implements Repository {
  constructor(private client: PoolClient, private schema: string, private hook?: (stage: string) => void) {}
  async get<K extends Table>(table: K, id: string, lock = false): Promise<Tables[K] | undefined> {
    const result = await this.client.query(`SELECT * FROM ${this.schema}.${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] ? mapRow<Tables[K]>(result.rows[0]) : undefined;
  }
  async list<K extends Table>(table: K): Promise<Tables[K][]> {
    const result = await this.client.query(`SELECT * FROM ${this.schema}.${table} ORDER BY created_at,id`);
    return result.rows.map(row => mapRow<Tables[K]>(row));
  }
  async insert<K extends Table>(table: K, row: Tables[K]) {
    const entries = Object.entries(row);
    await this.client.query(`INSERT INTO ${this.schema}.${table} (${entries.map(([k]) => k).join(',')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})`, entries.map(([, v]) => v));
    this.hook?.(`insert:${table}`);
  }
  async save<K extends Table>(table: K, row: Tables[K]) {
    const entries = Object.entries(row).filter(([k]) => k !== 'id');
    await this.client.query(`UPDATE ${this.schema}.${table} SET ${entries.map(([k], i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [row.id, ...entries.map(([, v]) => v)]);
    this.hook?.(`save:${table}`);
  }
  async emit(event: Event) {
    await this.client.query(`INSERT INTO ${this.schema}.outbox_events(event_id,type,routing_key,correlation_id,payload,occurred_at) VALUES ($1,$2,$2,$3,$4,$5)`, [event.event_id, event.type, event.correlation_id, event, event.occurred_at]);
    this.hook?.('emit');
  }
}
export class PgStore implements Store {
  readonly schema: string;
  constructor(readonly pool: Pool, schema: string, private hook?: (stage: string) => void) { this.schema = schemaName(schema); }
  async transaction<T>(work: (repo: Repository) => Promise<Result<T>>): Promise<Result<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await work(new PgRepository(client, this.schema, this.hook));
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK'); return result;
    } catch (error) {
      await client.query('ROLLBACK');
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'silos_codigo_key') return fail('SILO_CODE_DUPLICATE', 409);
      if (['55P03', '40P01', '40001', '57014'].includes(e.code ?? '')) return fail('CONCURRENCY_TIMEOUT', 409);
      throw error;
    } finally { client.release(); }
  }
}
