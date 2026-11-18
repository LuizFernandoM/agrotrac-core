import type { Pool } from 'pg';
import type { Event } from '../domain/model.js';
import { schemaName } from './postgres.js';
import type { Publisher } from './publisher.js';
export const backoff = (attempt: number) => Math.min(60_000, 250 * 2 ** Math.min(attempt - 1, 8));
export class OutboxWorker {
  private schema: string;
  constructor(private pool: Pool, schema: string, private publisher: Publisher) { this.schema = schemaName(schema); }
  async dispatchOne(): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Row lock remains held through bounded broker I/O and status update.
      const result = await c.query(`SELECT event_id,routing_key,payload,attempts FROM ${this.schema}.outbox_events WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = result.rows[0];
      if (!row) { await c.query('COMMIT'); return false; }
      try {
        await this.publisher.publish(row.payload as Event, row.routing_key);
        await c.query(`UPDATE ${this.schema}.outbox_events SET status='PUBLISHED',published_at=now(),attempts=attempts+1,last_error=NULL WHERE event_id=$1`, [row.event_id]);
      } catch {
        await c.query(`UPDATE ${this.schema}.outbox_events SET attempts=attempts+1,next_attempt_at=now()+($2::integer * interval '1 millisecond'),last_error='BROKER_DELIVERY_FAILED' WHERE event_id=$1`, [row.event_id, backoff(row.attempts + 1)]);
      }
      await c.query('COMMIT'); return true;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
