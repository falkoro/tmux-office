export type DeskStatus = 'working' | 'needs-permission' | 'waiting-input' | 'done' | 'idle';

export interface StatusInput {
  bubbleType: 'permission' | 'waiting' | null;
  waitingAwaitingInput?: boolean;
  isActive: boolean;
  /** An open question tool; without hooks this is the only "waiting for you" signal. */
  asking?: boolean;
}

// First match wins. Active sits above the waiting rows because the office only
// fades a turn-end bubble in its 2D game loop: when the agent starts its next
// turn, a stale 'waiting' bubble must not keep it looking finished.
const STATUS_TABLE: ReadonlyArray<readonly [(c: StatusInput) => boolean, DeskStatus]> = [
  [(c) => c.bubbleType === 'permission', 'needs-permission'],
  [(c) => c.isActive && c.asking === true, 'waiting-input'],
  [(c) => c.isActive, 'working'],
  [(c) => c.bubbleType === 'waiting' && c.waitingAwaitingInput === true, 'waiting-input'],
  [(c) => c.bubbleType === 'waiting', 'done'],
];

export function deskStatus(c: StatusInput): DeskStatus {
  return STATUS_TABLE.find(([matches]) => matches(c))?.[1] ?? 'idle';
}
