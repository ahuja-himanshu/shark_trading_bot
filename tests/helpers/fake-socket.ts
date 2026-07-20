import type {
  SocketLike,
  SocketManagerLike,
} from "../../src/streams/socket.js";

type Listener = (...args: unknown[]) => void;

class FakeSocketManager implements SocketManagerLike {
  private readonly listeners = new Set<() => void>();

  public on(_event: "ping", listener: () => void): this {
    this.listeners.add(listener);
    return this;
  }

  public off(_event: "ping", listener: () => void): this {
    this.listeners.delete(listener);
    return this;
  }

  public ping(): void {
    for (const listener of this.listeners) listener();
  }
}

export class FakeSocket implements SocketLike {
  public connected = false;
  public readonly io = new FakeSocketManager();
  public readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  public connectCalls = 0;
  public disconnectCalls = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  public on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  public off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  public emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }

  public connect(): this {
    this.connectCalls += 1;
    return this;
  }

  public disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  public serverEmit(event: string, ...args: unknown[]): void {
    if (event === "connect") this.connected = true;
    if (event === "disconnect") this.connected = false;
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export function socketFactoryHarness(): {
  sockets: FakeSocket[];
  urls: string[];
  factory: (url: string) => FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  return {
    sockets,
    urls,
    factory: (url: string) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

export async function flushPromises(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}
