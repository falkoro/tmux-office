// webview-ui/src/office/engine/existingAgents.ts
//
// Pure reconciliation for the `existingAgents` restore message. Extracted from
// useExtensionMessages so it can be unit-tested without React (mirrors
// officeCanvasCursor.ts). The deliberate e2e-over-unit policy forbids unit
// tests against the React message handler itself.
//
// The webview must handle BOTH orders in which the two restore messages arrive:
//   - existingAgents before layoutLoaded → buffer, flush on the next layoutLoaded
//   - layoutLoaded before existingAgents → layout + seats already built, add now
// Depending on layoutLoaded always arriving last stranded restored agents on any
// surface that sends layout first (e.g. the VS Code no-assets path), issue #334.

/** Per-agent seat metadata carried by the existingAgents message. */
export interface ExistingAgentMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

/** An agent buffered until the layout (and its seats) has been built. */
export interface PendingAgent {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  folderName?: string;
  isHeadless?: boolean;
}

/** Minimal structural view of OfficeState this reconciler needs. */
export interface ExistingAgentsOffice {
  characters: { has: (id: number) => boolean };
  addAgent: (
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ) => void;
  setHeadless: (id: number, headless: boolean) => void;
}

/**
 * Reconcile an `existingAgents` payload into the office. When the layout is
 * already built, agents are added immediately (skipping the matrix spawn effect,
 * as restored agents do) unless they already exist; otherwise they are pushed
 * onto `pending` to be flushed by the next `layoutLoaded`. Returns true if any
 * agent was added directly, so the caller can persist seat assignments.
 */
export function reconcileExistingAgents(
  os: ExistingAgentsOffice,
  incoming: number[],
  meta: Record<number, ExistingAgentMeta>,
  folderNames: Record<number, string>,
  layoutReady: boolean,
  pending: PendingAgent[],
  headlessAgents: Record<number, boolean> = {},
): boolean {
  let addedDirectly = false;
  for (const id of incoming) {
    const m = meta[id];
    const p: PendingAgent = {
      id,
      palette: m?.palette,
      hueShift: m?.hueShift,
      seatId: m?.seatId,
      folderName: folderNames[id],
      isHeadless: headlessAgents[id] === true,
    };
    if (layoutReady) {
      if (!os.characters.has(p.id)) {
        os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName);
        if (p.isHeadless) os.setHeadless(p.id, true);
        addedDirectly = true;
      }
    } else {
      pending.push(p);
    }
  }
  return addedDirectly;
}

/**
 * Drop the tmux placement of every character a reconnect snapshot leaves out
 * of its terminal map. The snapshot's own entries are stamped afterwards.
 */
export function clearMissingTerminals(
  characters: Iterable<[number, { tmux?: unknown; sessionName?: string | null }]>,
  terminals: Record<string, unknown>,
): void {
  for (const [id, ch] of characters) {
    if (terminals[id] !== undefined) continue;
    ch.tmux = null;
    ch.sessionName = null;
  }
}

/**
 * Top-level agents (id > 0) on screen that a snapshot no longer lists: they
 * ended while the client was away and their agentClosed never arrived.
 */
export function agentsMissingFrom(characterIds: Iterable<number>, incoming: number[]): number[] {
  const live = new Set(incoming);
  return [...characterIds].filter((id) => id > 0 && !live.has(id));
}

/** Structural view of OfficeState for clearing a surviving agent's status. */
export interface StatusResetOffice {
  characters: Map<number, { bubbleType: unknown; bubbleTimer: number }>;
  setAgentActive: (id: number, active: boolean) => void;
  setAgentTool: (id: number, tool: string | null) => void;
}

/**
 * Agents a snapshot lists that are already on screen: drop the status they
 * showed before the drop, since the snapshot's replay only re-sends what is
 * still true.
 */
export function resetSurvivingStatus(os: StatusResetOffice, incoming: number[]): void {
  for (const id of incoming) {
    const ch = os.characters.get(id);
    if (!ch) continue;
    os.setAgentActive(id, false);
    os.setAgentTool(id, null);
    ch.bubbleType = null;
    ch.bubbleTimer = 0;
  }
}
