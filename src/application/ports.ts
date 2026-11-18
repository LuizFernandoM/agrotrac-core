import type { Event, Result, Table, Tables } from '../domain/model.js';
export interface Repository {
  get<K extends Table>(table: K, id: string, lock?: boolean): Promise<Tables[K] | undefined>;
  list<K extends Table>(table: K): Promise<Tables[K][]>;
  insert<K extends Table>(table: K, row: Tables[K]): Promise<void>;
  save<K extends Table>(table: K, row: Tables[K]): Promise<void>;
  emit(event: Event): Promise<void>;
}
export interface Store {
  transaction<T>(work: (repo: Repository) => Promise<Result<T>>): Promise<Result<T>>;
}
export type Runtime = { id(): string; now(): string };
