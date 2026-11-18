import type { Pool } from 'pg';
import { schemaName } from './postgres.js';
// Additive, schema-qualified DDL only. Existing unknown tables are refused.
export async function migrate(pool: Pool, schema: string, requireNew = false) {
  const s = schemaName(schema), client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agrotrac-core:${schema}`]);
    const exists = await client.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=$1', [schema]);
    if (requireNew && exists.rowCount) throw new Error('Integration requires a brand new schema');
    const tables = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [schema]);
    if (tables.rowCount) {
      const marker = tables.rows.some(r => r.table_name === 'core_migrations');
      if (!marker) throw new Error('Existing unrecognized schema; inspect manually before migration');
      const version = await client.query(`SELECT version FROM ${s}.core_migrations`);
      if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error('Unrecognized migration version');
      await client.query('COMMIT'); return;
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`
      CREATE TABLE ${s}.silos (
        id uuid PRIMARY KEY, codigo varchar(50) NOT NULL UNIQUE CHECK(length(trim(codigo))>0), nome varchar(100) NOT NULL CHECK(length(trim(nome))>0), tipo_grao varchar(50) NOT NULL CHECK(length(trim(tipo_grao))>0),
        capacidade_total_kg bigint NOT NULL CHECK(capacidade_total_kg BETWEEN 1 AND 9007199254740991),
        ocupacao_fisica_kg bigint NOT NULL DEFAULT 0 CHECK(ocupacao_fisica_kg BETWEEN 0 AND 9007199254740991),
        saldo_reservado_kg bigint NOT NULL DEFAULT 0 CHECK(saldo_reservado_kg BETWEEN 0 AND 9007199254740991),
        status text NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')), version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        CHECK(ocupacao_fisica_kg <= capacidade_total_kg AND saldo_reservado_kg <= capacidade_total_kg - ocupacao_fisica_kg)
      );
      CREATE TABLE ${s}.windows (
        id uuid PRIMARY KEY, silo_id uuid NOT NULL REFERENCES ${s}.silos(id), inicio_em timestamptz NOT NULL, termino_em timestamptz NOT NULL CHECK(termino_em>inicio_em),
        capacidade_maxima_kg bigint NOT NULL CHECK(capacidade_maxima_kg BETWEEN 1 AND 9007199254740991),
        saldo_reservado_kg bigint NOT NULL CHECK(saldo_reservado_kg BETWEEN 0 AND capacidade_maxima_kg),
        status text NOT NULL CHECK(status IN ('OPEN','BLOCKED','CLOSED')), version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE(id,silo_id)
      );
      CREATE TABLE ${s}.bookings (
        id uuid PRIMARY KEY, silo_id uuid NOT NULL REFERENCES ${s}.silos(id), window_id uuid NOT NULL,
        placa varchar(7) NOT NULL CHECK(placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'), motorista_nome varchar(100) NOT NULL CHECK(length(trim(motorista_nome))>=2), motorista_documento varchar(100),
        peso_estimado_kg bigint NOT NULL CHECK(peso_estimado_kg BETWEEN 1 AND 9007199254740991),
        status text NOT NULL CHECK(status IN ('CONFIRMED','CANCELLED','COMPLETED')), cancelled_at timestamptz, motivo varchar(500),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        FOREIGN KEY(window_id,silo_id) REFERENCES ${s}.windows(id,silo_id), CHECK((status='CANCELLED') = (cancelled_at IS NOT NULL))
      );
      CREATE INDEX ON ${s}.bookings(silo_id,window_id,status);
      CREATE TABLE ${s}.outbox_events (
        event_id uuid PRIMARY KEY, type varchar(100) NOT NULL, routing_key varchar(100) NOT NULL,
        correlation_id uuid NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHED')),
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error varchar(100), published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ON ${s}.outbox_events(next_attempt_at,created_at) WHERE status='PENDING';
      CREATE TABLE ${s}.core_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO ${s}.core_migrations(version) VALUES (1);
    `);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
