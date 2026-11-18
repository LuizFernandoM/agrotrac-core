import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
export function configuration() {
  // Explicit opt-in only. Never auto-discover or log the local infrastructure secrets.
  const local = process.env.CORE_INFRA_ENV_PATH ? parse(readFileSync(process.env.CORE_INFRA_ENV_PATH)) : {};
  const env = { ...local, ...process.env };
  const schema = env.CORE_DB_SCHEMA;
  if (!schema || !/^[a-z][a-z0-9_]{0,62}$/.test(schema) || ['public', 'information_schema'].includes(schema) || schema.startsWith('pg_')) throw new Error('CORE_DB_SCHEMA must name an explicit non-system schema');
  const pool = new Pool(env.DATABASE_URL ? { connectionString: env.DATABASE_URL, max: 15, connectionTimeoutMillis: 5000 } : {
    host: env.PGHOST ?? '127.0.0.1', port: Number(env.PGPORT ?? 5432), user: env.PGUSER ?? env.POSTGRES_USER,
    password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD, database: env.PGDATABASE ?? env.POSTGRES_DB,
    max: 15, connectionTimeoutMillis: 5000,
  });
  // No raw driver error logging: connection errors can contain sensitive metadata.
  pool.on('error', () => {});
  const rabbit = env.RABBITMQ_URL ?? `amqp://${encodeURIComponent(env.RABBITMQ_DEFAULT_USER ?? '')}:${encodeURIComponent(env.RABBITMQ_DEFAULT_PASS ?? '')}@127.0.0.1:5672`;
  return { pool, schema, rabbit, host: env.CORE_HOST ?? '127.0.0.1', port: Number(env.CORE_PORT ?? 3001) };
}
