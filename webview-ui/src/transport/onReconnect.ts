import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { MessageTransport } from './types.js';

/** Calls `handler` each time the transport is connected again after a drop. */
export function onReconnect(
  transport: Pick<MessageTransport, 'onStateChange'>,
  handler: () => void,
): () => void {
  let dropped = false;
  return transport.onStateChange((state) => {
    if (state === TRANSPORT_STATE_RECONNECTING) dropped = true;
    else if (state === TRANSPORT_STATE_CONNECTED && dropped) {
      dropped = false;
      handler();
    }
  });
}
