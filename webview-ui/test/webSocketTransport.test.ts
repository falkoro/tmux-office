import { afterEach, describe, expect, it, vi } from 'vitest';

import { onReconnect } from '../src/transport/onReconnect.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

class FakeSocket {
  static readonly OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.sockets.push(this);
  }
  send(data: string): void {
    this.sent.push((JSON.parse(data) as { type: string }).type);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  close(): void {}
}

describe('WebSocketTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSocket.sockets = [];
  });

  it('sends what the user did offline before the reconnect snapshot request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const transport = new WebSocketTransport('ws://test/ws');
    onReconnect(transport);
    transport.connect();
    FakeSocket.sockets[0]!.open();
    FakeSocket.sockets[0]!.drop();

    transport.send({ type: 'setSoundEnabled', enabled: false });
    // A restarted server reuses agent ids, so these would hit someone else's agent.
    transport.send({ type: 'closeAgent', id: 5 });
    transport.send({ type: 'focusAgent', id: 5 });
    transport.send({ type: 'saveAgentSeats', seats: {} });
    await vi.runOnlyPendingTimersAsync();
    FakeSocket.sockets[1]!.open();

    expect(FakeSocket.sockets[1]!.sent).toEqual(['setSoundEnabled', 'webviewReady']);
    transport.dispose();
  });

  it('sends agent-id messages queued before the first connection', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const transport = new WebSocketTransport('ws://test/ws');
    transport.connect();
    transport.send({ type: 'focusAgent', id: 1 });
    FakeSocket.sockets[0]!.open();

    expect(FakeSocket.sockets[0]!.sent).toEqual(['focusAgent']);
    transport.dispose();
  });
});
