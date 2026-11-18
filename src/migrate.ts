import { configuration } from './infra/config.js';
import { migrate } from './infra/migration.js';
const { pool, schema } = configuration();
try { await migrate(pool, schema); console.log(`Migration applied: ${schema}`); }
catch { console.error('Migration failed; inspect schema and connection locally.'); process.exitCode = 1; }
finally { await pool.end(); }
