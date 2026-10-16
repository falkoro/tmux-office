import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { MessageTransport } from './types.js';

/**
 * Each time the transport is connected again after a drop, asks the server
 * for a fresh snapshot and calls `handler`.
 */
export function onReconnect(
  transport: Pick<MessageTransport, 'onStateChange' | 'send'>,
  handler: () => void,
): () => void {
  let connected = false;
  let dropped = false;
  return transport.onStateChange((state) => {
    if (state === TRANSPORT_STATE_RECONNECTING) dropped = connected;
    else if (state === TRANSPORT_STATE_CONNECTED) {
      connected = true;
      if (!dropped) return;
      dropped = false;
      transport.send({ type: 'webviewReady' });
      handler();
    }
  });
}
