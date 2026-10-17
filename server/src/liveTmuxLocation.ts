import {
  type ProcReader,
  realProc,
  runsInPane,
  type TmuxLocation,
} from './providers/hook/claude/claudeSessionRegistry.js';
import { isSafeTmuxLocation, type TmuxPaneRecord } from './tmuxTerminal.js';

/**
 * Where each live session sits, after one pane listing.
 *
 * `panes === null` means the listing failed or has not arrived: keep each
 * session's registry location. An empty list is a successful read, so a pane
 * id that is absent becomes null. A listed pane keeps its id and takes the
 * session and window tmux reports now. Pane ids are unique only per tmux
 * server, so a listing counts only when /proc shows the Claude process runs in
 * that pane; where /proc cannot tell (macOS), only a listing under the
 * registry's own session counts. A pane listed under several sessions (a
 * grouped session) keeps the registry's session if it is one of them, else
 * takes the first; with none the location is null. Unsafe names become null.
 */
export function resolveLiveTmuxLocations(
  sessions: readonly { sessionId: string; pid: number; tmux: TmuxLocation | null }[],
  panes: readonly TmuxPaneRecord[] | null,
  proc: ProcReader = realProc,
): Map<string, TmuxLocation | null> {
  const resolved = new Map<string, TmuxLocation | null>();
  if (panes === null) {
    for (const session of sessions) {
      const location = session.tmux;
      resolved.set(
        session.sessionId,
        location && isSafeTmuxLocation(location) ? { ...location } : null,
      );
    }
    return resolved;
  }

  const byPane = new Map<string, TmuxPaneRecord[]>();
  for (const pane of panes) {
    const listings = byPane.get(pane.paneId);
    if (listings) listings.push(pane);
    else byPane.set(pane.paneId, [pane]);
  }

  for (const session of sessions) {
    const current = session.tmux;
    if (!current) {
      resolved.set(session.sessionId, null);
      continue;
    }
    const listings = byPane.get(current.paneId);
    const owned = listings?.filter(
      (pane) => runsInPane(session.pid, pane.panePid, proc) ?? pane.session === current.session,
    );
    const found = owned?.find((pane) => pane.session === current.session) ?? owned?.[0];
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
