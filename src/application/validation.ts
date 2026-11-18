import { kg, text, utc, uuid } from '../domain/model.js';
export type Input = Record<string, unknown>;
export const object = (v: unknown): v is Input => !!v && typeof v === 'object' && !Array.isArray(v);
export const reasonValid = (v: unknown) => v === undefined || v === null || text(v, 0, 500);
export function validSilo(b: Input) {
  return text(b.codigo, 1, 50) && text(b.nome) && text(b.tipo_grao, 1, 50) && kg(b.capacidade_total_kg, true)
    && kg(b.ocupacao_fisica_kg ?? 0) && Number(b.ocupacao_fisica_kg ?? 0) <= b.capacidade_total_kg;
}
export function validWindow(b: Input) {
  return uuid(b.silo_id) && utc(b.inicio_em) && utc(b.termino_em) && Date.parse(b.termino_em) > Date.parse(b.inicio_em) && kg(b.capacidade_maxima_kg, true);
}
export function validBooking(b: Input) {
  return uuid(b.window_id) && typeof b.placa === 'string' && /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(b.placa)
    && text(b.motorista_nome, 2, 100) && (b.motorista_documento === undefined || b.motorista_documento === null || text(b.motorista_documento, 1, 100)) && kg(b.peso_estimado_kg, true);
}
