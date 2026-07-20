import { io } from "socket.io-client";

export interface SocketManagerLike {
  on(event: "ping", listener: () => void): this;
  off(event: "ping", listener: () => void): this;
}

export interface SocketLike {
  readonly connected: boolean;
  readonly io: SocketManagerLike;
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): this;
  connect(): this;
  disconnect(): this;
}

export type SocketFactory = (url: string) => SocketLike;

export const createSocket: SocketFactory = (url) =>
  io(url, {
    autoConnect: false,
    reconnection: false,
    transports: ["websocket"],
    upgrade: false,
  }) as unknown as SocketLike;

export function safeSocketErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "SOCKET_ERROR";
  const record = error as Record<string, unknown>;
  if (
    typeof record.code === "string" &&
    /^[A-Z0-9_-]{1,64}$/i.test(record.code)
  )
    return record.code.toUpperCase();
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name))
    return error.name.toUpperCase();
  return "SOCKET_ERROR";
}

export function messageSize(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized);
  } catch {
    return null;
  }
}
