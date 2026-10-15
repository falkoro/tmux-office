import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_RECONNECTING,
} from '../../core/src/constants.js';
import type { TransportState } from '../../core/src/transport.js';
import { onReconnect } from '../src/transport/onReconnect.js';

describe('onReconnect', () => {
  it('fires once per return after a drop, not on the first connect', () => {
    let emit: (state: TransportState) => void = () => undefined;
    let fired = 0;
    onReconnect(
      {
        onStateChange: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
      () => (fired += 1),
    );
    emit(TRANSPORT_STATE_CONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(fired).toBe(0);
    emit(TRANSPORT_STATE_RECONNECTING);
    emit(TRANSPORT_STATE_CONNECTED);
    expect(fired).toBe(1);
  });
});
