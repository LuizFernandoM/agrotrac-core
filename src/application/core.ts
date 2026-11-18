import { fail, ok, reserve, snapshot, utc, uuid, type Booking, type Event, type Result, type Silo, type Table, type Tables, type Window } from '../domain/model.js';
import type { Repository, Runtime, Store } from './ports.js';
import { object, reasonValid, validBooking, validSilo, validWindow, type Input } from './validation.js';

export class Core {
  constructor(private store: Store, private runtime: Runtime) {}
  private event(repo: Repository, kind: string, correlation: string, s: Silo, w?: Window, b?: Booking, motivo: unknown = null) {
    const payload: Event['payload'] = { silo_id: s.id, silo_version: s.version, silo: snapshot(s), saldo_disponivel_silo_kg: snapshot(s).saldo_disponivel_kg };
    if (w) Object.assign(payload, { window_id: w.id, window_version: w.version, window: snapshot(w), inicio_em: w.inicio_em, termino_em: w.termino_em, status: w.status, updated_at: w.updated_at, motivo, saldo_disponivel_janela_kg: snapshot(w).saldo_disponivel_kg });
    if (b) Object.assign(payload, { booking_id: b.id, booking: b, placa: b.placa, motorista_nome: b.motorista_nome, peso_estimado_kg: b.peso_estimado_kg, ...(b.status === 'CANCELLED' ? { peso_estornado_kg: b.peso_estimado_kg, cancelled_at: b.cancelled_at, motivo: b.motivo } : {}) });
    return repo.emit({ event_id: this.runtime.id(), type: `agrotrac.core.${kind}`, version: '1.0.0', producer: 'agrotrac-core', occurred_at: this.runtime.now(), correlation_id: correlation, payload });
  }
  async createSilo(input: unknown, correlation: string): Promise<Result<Silo>> {
    if (!object(input) || !validSilo(input) || !uuid(correlation)) return fail('INVALID_PAYLOAD');
    const b = input;
    return this.store.transaction(async r => {
      if ((await r.list('silos')).some(s => s.codigo === b.codigo)) return fail('SILO_CODE_DUPLICATE', 409);
      const now = this.runtime.now();
      const s: Silo = { id: this.runtime.id(), codigo: b.codigo as string, nome: b.nome as string, tipo_grao: b.tipo_grao as string, capacidade_total_kg: b.capacidade_total_kg as number, ocupacao_fisica_kg: (b.ocupacao_fisica_kg ?? 0) as number, saldo_reservado_kg: 0, status: 'ACTIVE', version: 1, created_at: now, updated_at: now };
      await r.insert('silos', s); await this.event(r, 'silo.created', correlation, s); return ok(s);
    });
  }
  async createWindow(input: unknown, correlation: string): Promise<Result<Window>> {
    if (!object(input) || !validWindow(input) || !uuid(correlation)) return fail('INVALID_PAYLOAD');
    const b = input;
    return this.store.transaction(async r => {
      const s = await r.get('silos', b.silo_id as string, true);
      if (!s) return fail('SILO_NOT_FOUND', 404);
      const now = this.runtime.now();
      const w: Window = { id: this.runtime.id(), silo_id: s.id, inicio_em: new Date(b.inicio_em as string).toISOString(), termino_em: new Date(b.termino_em as string).toISOString(), capacidade_maxima_kg: b.capacidade_maxima_kg as number, saldo_reservado_kg: 0, status: 'OPEN', version: 1, created_at: now, updated_at: now };
      await r.insert('windows', w); await this.event(r, 'window.created', correlation, s, w); return ok(w);
    });
  }
  async createBooking(input: unknown, correlation: string): Promise<Result<Booking>> {
    if (!object(input) || !validBooking(input) || !uuid(correlation)) return fail('INVALID_PAYLOAD');
    const b = input;
    return this.store.transaction(async r => {
      const located = await r.get('windows', b.window_id as string);
      if (!located) return fail('WINDOW_NOT_FOUND', 404);
      const s = await r.get('silos', located.silo_id, true);
      const w = await r.get('windows', located.id, true);
      if (!s || !w || w.silo_id !== s.id) return fail('WINDOW_NOT_FOUND', 404);
      const now = this.runtime.now(), weight = b.peso_estimado_kg as number;
      const checked = reserve(s, w, weight, now); if (!checked.ok) return checked;
      s.saldo_reservado_kg += weight; w.saldo_reservado_kg += weight;
      s.version++; w.version++; s.updated_at = w.updated_at = now;
      const booking: Booking = { id: this.runtime.id(), silo_id: s.id, window_id: w.id, placa: b.placa as string, motorista_nome: b.motorista_nome as string, motorista_documento: (b.motorista_documento ?? null) as string | null, peso_estimado_kg: weight, status: 'CONFIRMED', cancelled_at: null, motivo: null, created_at: now, updated_at: now };
      await r.save('silos', s); await r.save('windows', w); await r.insert('bookings', booking);
      await this.event(r, 'booking.created', correlation, s, w, booking); return ok(booking);
    });
  }
  async cancelBooking(id: string, input: unknown, correlation: string): Promise<Result<Booking>> {
    if (!uuid(id) || !uuid(correlation) || !object(input) || !reasonValid(input.motivo)) return fail('INVALID_PAYLOAD');
    return this.store.transaction(async r => {
      const located = await r.get('bookings', id);
      if (!located) return fail('BOOKING_NOT_FOUND', 404);
      const s = await r.get('silos', located.silo_id, true);
      const w = await r.get('windows', located.window_id, true);
      const b = await r.get('bookings', id, true);
      if (!s || !w || !b || b.silo_id !== s.id || b.window_id !== w.id || w.silo_id !== s.id) return fail('BOOKING_NOT_FOUND', 404);
      if (b.status === 'CANCELLED') return ok(b);
      if (b.status === 'COMPLETED') return fail('BOOKING_ALREADY_COMPLETED', 409);
      const now = this.runtime.now();
      s.saldo_reservado_kg -= b.peso_estimado_kg; w.saldo_reservado_kg -= b.peso_estimado_kg;
      s.version++; w.version++; s.updated_at = w.updated_at = now;
      b.status = 'CANCELLED'; b.updated_at = b.cancelled_at = now; b.motivo = (input.motivo ?? null) as string | null;
      await r.save('silos', s); await r.save('windows', w); await r.save('bookings', b);
      await this.event(r, 'booking.cancelled', correlation, s, w, b); return ok(b);
    });
  }
  async updateWindow(id: string, input: unknown, correlation: string): Promise<Result<Window>> {
    if (!uuid(id) || !uuid(correlation) || !object(input) || !['OPEN', 'BLOCKED', 'CLOSED'].includes(input.status as string) || !reasonValid(input.motivo)) return fail('INVALID_PAYLOAD');
    return this.store.transaction(async r => {
      const located = await r.get('windows', id); if (!located) return fail('WINDOW_NOT_FOUND', 404);
      const s = await r.get('silos', located.silo_id, true); const w = await r.get('windows', id, true);
      if (!s || !w || w.silo_id !== s.id) return fail('WINDOW_NOT_FOUND', 404);
      if (w.status === 'CLOSED' && input.status !== 'CLOSED') return fail('WINDOW_CLOSED', 409);
      if (w.status === input.status) return ok(w);
      w.status = input.status as Window['status']; w.version++; w.updated_at = this.runtime.now();
      await r.save('windows', w); await this.event(r, 'window.updated', correlation, s, w, undefined, input.motivo ?? null); return ok(w);
    });
  }
  async get<K extends Table>(table: K, id: string): Promise<Result<Tables[K]>> {
    if (!uuid(id)) return fail('INVALID_PAYLOAD');
    return this.store.transaction(async r => { const value = await r.get(table, id); return value ? ok(value) : fail(`${table === 'silos' ? 'SILO' : table === 'windows' ? 'WINDOW' : 'BOOKING'}_NOT_FOUND`, 404); });
  }
  async list<K extends Table>(table: K, filters: Input): Promise<Result<Tables[K][]>> {
    for (const key of Object.keys(filters)) {
      const value = filters[key];
      if (!['status', ...(table === 'windows' ? ['silo_id', 'data_inicio', 'data_fim'] : table === 'bookings' ? ['silo_id', 'window_id'] : [])].includes(key)) return fail('INVALID_PAYLOAD');
      if (key.endsWith('_id') && !uuid(value)) return fail('INVALID_PAYLOAD');
      if (key.startsWith('data_') && !utc(value)) return fail('INVALID_PAYLOAD');
      if (key === 'status' && !(table === 'silos' ? ['ACTIVE', 'INACTIVE'] : table === 'windows' ? ['OPEN', 'BLOCKED', 'CLOSED'] : ['CONFIRMED', 'CANCELLED', 'COMPLETED']).includes(value as string)) return fail('INVALID_PAYLOAD');
    }
    if (filters.data_inicio && filters.data_fim && Date.parse(filters.data_inicio as string) > Date.parse(filters.data_fim as string)) return fail('INVALID_PAYLOAD');
    return this.store.transaction(async r => ok((await r.list(table)).filter(row => Object.entries(filters).every(([key, val]) => key === 'data_inicio' ? (row as Window).inicio_em >= new Date(val as string).toISOString() : key === 'data_fim' ? (row as Window).termino_em <= new Date(val as string).toISOString() : (row as unknown as Input)[key] === val))));
  }
}
