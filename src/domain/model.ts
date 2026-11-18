export type Failure = { code: string; message: string; status: number; details: unknown };
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: string, status = 400, details: unknown = null): Result<never> =>
  ({ ok: false, error: { code, status, message: code, details } });
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const kg = (v: unknown, positive = false): v is number => Number.isSafeInteger(v) && (v as number) >= (positive ? 1 : 0);
export const text = (v: unknown, min = 1, max = 100): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
export const utc = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === (v.length === 20 ? v.replace('Z', '.000Z') : v);
};
export type Base = { id: string; created_at: string; updated_at: string };
export type Silo = Base & { codigo: string; nome: string; tipo_grao: string; capacidade_total_kg: number; ocupacao_fisica_kg: number; saldo_reservado_kg: number; status: 'ACTIVE' | 'INACTIVE'; version: number };
export type Window = Base & { silo_id: string; inicio_em: string; termino_em: string; capacidade_maxima_kg: number; saldo_reservado_kg: number; status: 'OPEN' | 'BLOCKED' | 'CLOSED'; version: number };
export type Booking = Base & { silo_id: string; window_id: string; placa: string; motorista_nome: string; motorista_documento: string | null; peso_estimado_kg: number; status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'; cancelled_at: string | null; motivo: string | null };
export type Tables = { silos: Silo; windows: Window; bookings: Booking };
export type Table = keyof Tables;
export type Event = { event_id: string; type: string; version: '1.0.0'; producer: 'agrotrac-core'; occurred_at: string; correlation_id: string; payload: Record<string, unknown> };
export const siloAvailable = (s: Silo) => s.capacidade_total_kg - s.ocupacao_fisica_kg - s.saldo_reservado_kg;
export const windowAvailable = (w: Window) => w.capacidade_maxima_kg - w.saldo_reservado_kg;
export const snapshot = (entity: Silo | Window) => ({ ...entity, saldo_disponivel_kg: 'codigo' in entity ? siloAvailable(entity) : windowAvailable(entity) });
export function reserve(s: Silo, w: Window, weight: number, now: string): Result<void> {
  if (!kg(weight, true)) return fail('INVALID_PAYLOAD');
  if (s.status !== 'ACTIVE') return fail('SILO_INACTIVE', 409);
  if (w.status !== 'OPEN') return fail('WINDOW_NOT_OPEN', 409);
  if (Date.parse(w.termino_em) <= Date.parse(now)) return fail('WINDOW_EXPIRED', 422);
  if (weight > windowAvailable(w)) return fail('CAPACITY_EXCEEDED', 409);
  if (weight > siloAvailable(s)) return fail('SILO_CAPACITY_EXCEEDED', 409);
  return ok(undefined);
}
