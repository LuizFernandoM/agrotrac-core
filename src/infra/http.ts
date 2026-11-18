import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { Core } from '../application/core.js';
import { fail, snapshot, uuid, type Result, type Table, type Silo, type Window } from '../domain/model.js';
export function http(core: Core) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const correlations = new WeakMap<object, string>();
  app.addHook('onRequest', async (req, reply) => {
    const supplied = req.headers['x-correlation-id'];
    const correlation = uuid(supplied) ? supplied : randomUUID();
    correlations.set(req, correlation); reply.header('X-Correlation-Id', correlation);
    if (supplied !== undefined && !uuid(supplied)) return send(reply, fail('INVALID_PAYLOAD'), correlation);
  });
  const cid = (req: object) => correlations.get(req)!;
  function send(reply: { code(n: number): any; send(v: unknown): any }, result: Result<unknown>, correlation: string, status = 200): any {
    if (!result.ok) return reply.code(result.error.status).send({ error: { code: result.error.code, message: result.error.message, details: result.error.details, correlation_id: correlation, timestamp: new Date().toISOString() } });
    function view(v: unknown): unknown {
      if (Array.isArray(v)) return v.map(view);
      if (v && typeof v === 'object') {
        if ('capacidade_total_kg' in v || 'capacidade_maxima_kg' in v) return snapshot(v as Silo | Window);
        if ('status' in v && v.status === 'CANCELLED' && 'peso_estimado_kg' in v) return { ...v, peso_estornado_kg: v.peso_estimado_kg };
      }
      return v;
    }
    return reply.code(status).send(view(result.value));
  }
  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    send(reply, fail(status && status >= 400 && status < 500 ? 'INVALID_PAYLOAD' : 'INTERNAL_SERVER_ERROR', status && status >= 400 && status < 500 ? status : 500), cid(req));
  });
  app.setNotFoundHandler((req, reply) => send(reply, fail('NOT_FOUND', 404), cid(req)));
  for (const table of ['silos', 'windows', 'bookings'] as Table[]) {
    app.get(`/v1/core/${table}`, async (req, reply) => send(reply, await core.list(table, req.query as Record<string, unknown>), cid(req)));
    app.get<{ Params: { id: string } }>(`/v1/core/${table}/:id`, async (req, reply) => send(reply, await core.get(table, req.params.id), cid(req)));
  }
  app.post('/v1/core/silos', async (req, reply) => send(reply, await core.createSilo(req.body, cid(req)), cid(req), 201));
  app.post('/v1/core/windows', async (req, reply) => send(reply, await core.createWindow(req.body, cid(req)), cid(req), 201));
  app.post('/v1/core/bookings', async (req, reply) => send(reply, await core.createBooking(req.body, cid(req)), cid(req), 201));
  app.delete<{ Params: { id: string } }>('/v1/core/bookings/:id', async (req, reply) => send(reply, await core.cancelBooking(req.params.id, req.body ?? {}, cid(req)), cid(req)));
  app.patch<{ Params: { id: string } }>('/v1/core/windows/:id/status', async (req, reply) => send(reply, await core.updateWindow(req.params.id, req.body, cid(req)), cid(req)));
  return app;
}
