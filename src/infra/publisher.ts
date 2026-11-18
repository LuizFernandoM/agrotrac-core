import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { Event } from '../domain/model.js';
export type Topology = { exchange: string; liveQueue: string; auditQueue: string };
export const canonical: Topology = { exchange: 'agrotrac.events', liveQueue: 'agrotrac.live.events', auditQueue: 'agrotrac.audit.events' };
export function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BROKER_TIMEOUT')), milliseconds);
    promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); reject(new Error('BROKER_UNAVAILABLE')); });
  });
}
export interface Publisher { publish(event: Event, routingKey: string): Promise<void>; close(): Promise<void> }
export class RabbitPublisher implements Publisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private tail: Promise<void> = Promise.resolve();
  constructor(private url: string, readonly topology = canonical, private timeout = 5000) {}
  private async connect() {
    if (this.channel) return this.channel;
    // A channel may have closed while its TCP connection remained open.
    if (this.connection) await this.close();
    const connection = await bounded(amqp.connect(this.url, { timeout: this.timeout }), this.timeout);
    connection.on('error', () => {});
    connection.on('close', () => { if (this.connection === connection) { this.channel = undefined; this.connection = undefined; } });
    this.connection = connection;
    const channel = await bounded(connection.createConfirmChannel(), this.timeout);
    channel.on('error', () => {});
    channel.on('close', () => { if (this.channel === channel) this.channel = undefined; });
    await bounded((async () => {
      await channel.assertExchange(this.topology.exchange, 'topic', { durable: true, autoDelete: false });
      await channel.assertQueue(this.topology.liveQueue, { durable: true, autoDelete: false });
      await channel.assertQueue(this.topology.auditQueue, { durable: true, autoDelete: false });
      await channel.bindQueue(this.topology.liveQueue, this.topology.exchange, 'agrotrac.core.#');
      await channel.bindQueue(this.topology.auditQueue, this.topology.exchange, 'agrotrac.core.#');
      await channel.bindQueue(this.topology.auditQueue, this.topology.exchange, 'agrotrac.live.#');
    })(), this.timeout);
    this.channel = channel; return channel;
  }
  publish(event: Event, routingKey: string) {
    const work = this.tail.then(async () => {
      try {
        const channel = await this.connect();
        let returned = false;
        const onReturn = () => { returned = true; };
        channel.on('return', onReturn);
        try {
          const confirmation = new Promise<void>((resolve, reject) => {
            channel.publish(this.topology.exchange, routingKey, Buffer.from(JSON.stringify(event)), {
              persistent: true, mandatory: true, contentType: 'application/json', messageId: event.event_id,
              correlationId: event.correlation_id, type: event.type, timestamp: Math.floor(new Date(event.occurred_at).getTime() / 1000),
            }, error => error ? reject(new Error('BROKER_NACK')) : returned ? reject(new Error('BROKER_UNROUTED')) : resolve());
          });
          await bounded(confirmation, this.timeout);
        } finally { channel.removeListener('return', onReturn); }
      } catch { await this.close(); throw new Error('BROKER_DELIVERY_FAILED'); }
    });
    this.tail = work.catch(() => {}); return work;
  }
  async close() {
    const connection = this.connection; this.channel = undefined; this.connection = undefined;
    if (connection) {
      await bounded(connection.close(), this.timeout).catch(() => {
        // amqplib's public close waits for a protocol reply; a silent peer cannot reply.
        // Destroy our own socket after that deadline, never the shared broker.
        const internal = connection as unknown as { connection: { stream: { destroy(error: Error): void } } };
        internal.connection.stream.destroy(new Error('BROKER_CLOSE_TIMEOUT'));
      });
    }
  }
}
