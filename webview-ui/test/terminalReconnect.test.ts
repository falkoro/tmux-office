import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_RECONNECTING,
} from '../../core/src/constants.js';
import type { ClientMessage } from '../../core/src/messages.js';
import type { TransportState } from '../../core/src/transport.js';
import { onReconnect } from '../src/transport/onReconnect.js';

function fakeTransport(send: (msg: ClientMessage) => void = () => undefined) {
  let emit: (state: TransportState) => void = () => undefined;
  return {
    transport: {
      send,
      onStateChange: (handler: (state: TransportState) => void) => {
        emit = handler;
        return () => undefined;
      },
    },
    emit: (state: TransportState) => emit(state),
  };
}

describe('onReconnect', () => {
  it('fires once per return after a drop, not on the first connect', () => {
    let fired = 0;
    const { transport, emit } = fakeTransport();
    onReconnect(transport, () => (fired += 1));
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(fired).toBe(0);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(fired).toBe(1);
  });

  it('asks for a fresh snapshot after a drop, not on the first connect', () => {
    const sent: string[] = [];
    const { transport, emit } = fakeTransport((msg) => sent.push(msg.type));
    onReconnect(transport, () => undefined);
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual([]);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual(['webviewReady']);
  });
});
