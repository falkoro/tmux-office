import {
  procParentPid,
  type ProcReader,
  realProc,
  type TmuxLocation,
} from './providers/hook/claude/claudeSessionRegistry.js';
import { isSafeTmuxLocation, type TmuxPaneRecord } from './tmuxTerminal.js';

const MAX_PROCESS_DEPTH = 64;

/** `pid` is `panePid` or descends from it. False when /proc cannot tell. */
function runsInPane(pid: number, panePid: number, proc: ProcReader): boolean {
  for (let at = pid, depth = 0; at > 1 && depth < MAX_PROCESS_DEPTH; depth++) {
    if (at === panePid) return true;
    const stat = proc.stat(at);
    const parent = stat ? procParentPid(stat) : null;
    if (parent === null) return false;
    at = parent;
  }
  return false;
}

/**
 * Where each live session sits, after one pane listing.
 *
 * `panes === null` means the listing failed or has not arrived: keep each
 * session's registry location. An empty list is a successful read, so a pane
 * id that is absent becomes null. A listed pane keeps its id and takes the
 * session and window tmux reports now. A pane listed under several sessions
 * (a grouped session) keeps the registry's session if it is one of them.
 * Otherwise the pane moved, or it is another tmux server's pane with the same
 * id: the first listing is taken only when the Claude process runs in that
 * pane, else the location is null. Unsafe names become null.
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
    const found =
      listings?.find((pane) => pane.session === current.session) ??
      listings?.find((pane) => runsInPane(session.pid, pane.panePid, proc));
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
