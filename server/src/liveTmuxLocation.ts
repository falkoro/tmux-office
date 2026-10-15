import type { TmuxLocation } from './providers/hook/claude/claudeSessionRegistry.js';
import { isSafeTmuxLocation, type TmuxPaneRecord } from './tmuxTerminal.js';

/**
 * Where each live session sits, after one pane listing.
 *
 * `panes === null` means the listing failed or has not arrived: keep each
 * session's registry location. An empty list is a successful read, so a pane
 * id that is absent becomes null. A listed pane keeps its id and takes the
 * session and window tmux reports now. Unsafe names become null.
 */
export function resolveLiveTmuxLocations(
  sessions: readonly { sessionId: string; tmux: TmuxLocation | null }[],
  panes: readonly TmuxPaneRecord[] | null,
): Map<string, TmuxLocation | null> {
  const resolved = new Map<string, TmuxLocation | null>();
  if (panes === null) {
    for (const session of sessions) {
      resolved.set(session.sessionId, session.tmux ? { ...session.tmux } : null);
    }
    return resolved;
  }

  const byPane = new Map<string, TmuxPaneRecord>();
  for (const pane of panes) {
    byPane.set(pane.paneId, pane);
  }

  for (const session of sessions) {
    const current = session.tmux;
    if (!current) {
      resolved.set(session.sessionId, null);
      continue;
    }
    const found = byPane.get(current.paneId);
    if (!found) {
      resolved.set(session.sessionId, null);
      continue;
    }
    const location: TmuxLocation = {
      session: found.session,
      windowId: found.windowId,
      paneId: current.paneId,
    };
    resolved.set(session.sessionId, isSafeTmuxLocation(location) ? location : null);
  }
  return resolved;
}
