import type { Repository, Store } from '../../src/application/ports.js';
import type { Event, Result, Table, Tables } from '../../src/domain/model.js';
type State = { [K in Table]: Map<string, Tables[K]> } & { events: Event[] };
export class MemoryStore implements Store {
  state: State = { silos: new Map(), windows: new Map(), bookings: new Map(), events: [] };
  private tail: Promise<void> = Promise.resolve();
  constructor(private hook?: (stage: string) => void) {}
  async transaction<T>(work: (repo: Repository) => Promise<Result<T>>): Promise<Result<T>> {
    let unlock!: () => void;
    const previous = this.tail; this.tail = new Promise<void>(r => { unlock = r; }); await previous;
    const draft = structuredClone(this.state);
    const repository: Repository = {
      get: async <K extends Table>(table: K, id: string) => structuredClone(draft[table].get(id)) as Tables[K] | undefined,
      list: async <K extends Table>(table: K) => structuredClone([...draft[table].values()]) as Tables[K][],
      insert: async <K extends Table>(table: K, row: Tables[K]) => { (draft[table] as Map<string, Tables[K]>).set(row.id, structuredClone(row)); this.hook?.(`insert:${table}`); },
      save: async <K extends Table>(table: K, row: Tables[K]) => { (draft[table] as Map<string, Tables[K]>).set(row.id, structuredClone(row)); this.hook?.(`save:${table}`); },
      emit: async event => { draft.events.push(structuredClone(event)); this.hook?.('emit'); },
    };
    try { const result = await work(repository); if (result.ok) this.state = draft; return result; } finally { unlock(); }
  }
}
