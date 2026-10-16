import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_RECONNECTING,
} from '../../core/src/constants.js';
import type { ClientMessage } from '../../core/src/messages.js';
import type { TransportState } from '../../core/src/transport.js';
import { onReconnect } from '../src/transport/onReconnect.js';

function fakeTransport(
  send: (msg: ClientMessage) => void = () => undefined,
  state: TransportState = TRANSPORT_STATE_CONNECTING,
) {
  let emit: (state: TransportState) => void = () => undefined;
  return {
    transport: {
      send,
      state,
      onStateChange: (handler: (state: TransportState) => void) => {
        emit = handler;
        return () => undefined;
      },
    },
    emit: (state: TransportState) => emit(state),
  };
}

describe('onReconnect', () => {
  it('asks once per return after a drop', () => {
    const sent: string[] = [];
    const { transport, emit } = fakeTransport((msg) => sent.push(msg.type));
    onReconnect(transport);
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual(['webviewReady', 'webviewReady']);
  });

  it('asks for a fresh snapshot after a drop, not on the first connect', () => {
    const sent: string[] = [];
    const { transport, emit } = fakeTransport((msg) => sent.push(msg.type));
    onReconnect(transport);
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual([]);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual(['webviewReady']);
  });

  it('treats a first connect that failed and then succeeded as the first connect', () => {
    const sent: string[] = [];
    const { transport, emit } = fakeTransport((msg) => sent.push(msg.type));
    onReconnect(transport);
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual([]);
  });

  it('detects the first drop when it subscribes after the transport connected', () => {
    const sent: string[] = [];
    const { transport, emit } = fakeTransport(
      (msg) => sent.push(msg.type),
      TRANSPORT_STATE_CONNECTED,
    );
    onReconnect(transport);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(sent).toEqual(['webviewReady']);
  });
});
