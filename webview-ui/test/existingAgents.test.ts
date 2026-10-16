/**
 * Unit tests for the pure `reconcileExistingAgents` decision (issue #334).
 *
 * A restored agent must become a character regardless of whether the
 * `existingAgents` message arrives before or after `layoutLoaded`:
 *   - layout NOT ready → buffer (flushed later by layoutLoaded)
 *   - layout ready     → add immediately (else the agent is stranded, because no
 *                        further layoutLoaded arrives to flush the buffer)
 *
 * Extracted from useExtensionMessages so it is testable without React, mirroring
 * officeCanvasCursor.test.ts (the deliberate e2e-over-unit policy forbids unit
 * tests against the React message handler itself).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type {
  ExistingAgentMeta,
  ExistingAgentsOffice,
  PendingAgent,
} from '../src/office/engine/existingAgents.js';
import {
  agentsMissingFrom,
  clearMissingTerminals,
  isNewServer,
  reconcileExistingAgents,
  resetSurvivingStatus,
} from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';

// ── Helpers ────────────────────────────────────────────────────

interface AddAgentCall {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  skipSpawnEffect?: boolean;
  folderName?: string;
}

/** A fake office that records addAgent calls, mirroring how officeCanvasCursor
 *  tests inject closures instead of constructing a real OfficeState. */
function fakeOffice(
  existing: number[] = [],
): ExistingAgentsOffice & { calls: AddAgentCall[]; headless: number[] } {
  const ids = new Set(existing);
  const calls: AddAgentCall[] = [];
  const headless: number[] = [];
  return {
    calls,
    headless,
    characters: { has: (id: number) => ids.has(id) },
    addAgent: (id, palette, hueShift, seatId, skipSpawnEffect, folderName) => {
      ids.add(id);
      calls.push({ id, palette, hueShift, seatId, skipSpawnEffect, folderName });
    },
    setHeadless: (id, isHeadless) => {
      if (isHeadless) headless.push(id);
    },
  };
}

// ── layout ready → add immediately (the #334 regression) ────────

test('layout ready: adds restored agents immediately with their seat metadata', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { palette: 2, hueShift: 90, seatId: 'seat-a' },
  };
  const folderNames: Record<number, string> = { 5: 'alpha' };

  const addedDirectly = reconcileExistingAgents(os, [5], meta, folderNames, true, pending);

  assert.equal(addedDirectly, true);
  assert.equal(pending.length, 0, 'nothing should be buffered once the layout is ready');
  assert.deepEqual(os.calls, [
    // skipSpawnEffect must be true so restored agents don't replay the matrix effect.
    {
      id: 5,
      palette: 2,
      hueShift: 90,
      seatId: 'seat-a',
      skipSpawnEffect: true,
      folderName: 'alpha',
    },
  ]);
});

// ── layout not ready → buffer (preserved original behavior) ─────

test('layout not ready: buffers restored agents for the later layoutLoaded flush', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { palette: 2, hueShift: 90, seatId: 'seat-a' },
  };
  const folderNames: Record<number, string> = { 5: 'alpha' };

  const addedDirectly = reconcileExistingAgents(os, [5], meta, folderNames, false, pending);

  assert.equal(addedDirectly, false);
  assert.equal(os.calls.length, 0, 'no agent should be added before the layout is ready');
  assert.deepEqual(pending, [
    { id: 5, palette: 2, hueShift: 90, seatId: 'seat-a', folderName: 'alpha', isHeadless: false },
  ]);
});

test('layout not ready: a reconnect snapshot drops buffered agents it no longer lists', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  reconcileExistingAgents(os, [5, 6], {}, {}, false, pending);
  reconcileExistingAgents(os, [6], {}, {}, false, pending);

  assert.deepEqual(
    pending.map((p) => p.id),
    [6],
  );
});

// ── idempotence / dedup ─────────────────────────────────────────

test('layout ready: skips an agent that already exists and reports nothing added', () => {
  const os = fakeOffice([5]); // agent 5 already has a character
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [5], {}, {}, true, pending);

  assert.equal(addedDirectly, false);
  assert.equal(os.calls.length, 0);
  assert.equal(pending.length, 0);
});

test('layout ready: a mixed roster adds only the missing agent', () => {
  const os = fakeOffice([5]);
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [5, 6], {}, {}, true, pending);

  assert.equal(addedDirectly, true);
  assert.deepEqual(
    os.calls.map((c) => c.id),
    [6],
  );
});

// ── headless flag (adopted agents, no terminal to focus) ────────

test('layout ready: marks restored headless agents and leaves the others alone', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  reconcileExistingAgents(os, [5, 6], {}, {}, true, pending, { 5: true });

  assert.deepEqual(os.headless, [5]);
});

test('layout not ready: the headless flag rides along on the buffered agent', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  reconcileExistingAgents(os, [5, 6], {}, {}, false, pending, { 5: true });

  assert.equal(os.headless.length, 0, 'nothing is marked before the layout flush');
  assert.deepEqual(
    pending.map((p) => [p.id, p.isHeadless]),
    [
      [5, true],
      [6, false],
    ],
  );
});

// ── missing metadata is tolerated (undefined seat fields) ───────

test('layout ready: agent with no metadata is still added with undefined fields', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];

  const addedDirectly = reconcileExistingAgents(os, [7], {}, {}, true, pending);

  assert.equal(addedDirectly, true);
  assert.deepEqual(os.calls, [
    {
      id: 7,
      palette: undefined,
      hueShift: undefined,
      seatId: undefined,
      skipSpawnEffect: true,
      folderName: undefined,
    },
  ]);
});

// ── reconnect snapshot drops tmux placement it no longer vouches for ──

test('reconnect: a character missing from the terminal snapshot loses its pane and name', () => {
  const pane = { session: 'work', windowId: '@1', paneId: '%5' };
  const gone: { tmux?: unknown; sessionName?: string | null } = { tmux: pane, sessionName: 'work' };
  const kept: { tmux?: unknown; sessionName?: string | null } = { tmux: pane, sessionName: 'demo' };
  const characters = new Map([
    [1, gone],
    [2, kept],
  ]);

  clearMissingTerminals(characters, { 2: { name: 'demo', tmux: pane } });

  assert.equal(gone.tmux, null);
  assert.equal(gone.sessionName, null);
  assert.deepEqual(kept.tmux, pane);
  assert.equal(kept.sessionName, 'demo');
});

test('reconnect: an agent the snapshot no longer lists is closed, its sub-agents are left to it', () => {
  assert.deepEqual(agentsMissingFrom([1, 3, -1, 5], [1, 5, 7]), [3]);
});

test('reconnect: a surviving agent drops the status it showed before the drop', () => {
  const os = new OfficeState();
  os.addAgent(1);
  os.addAgent(2);
  os.setAgentTool(1, 'Bash');
  os.setAgentActive(1, true);
  os.showPermissionBubble(1);
  os.showWaitingBubble(2);

  resetSurvivingStatus(os, [1, 2]);

  for (const id of [1, 2]) {
    const ch = os.characters.get(id)!;
    assert.equal(ch.isActive, false);
    assert.equal(ch.currentTool, null);
    assert.equal(ch.bubbleType, null);
  }
});

test('reconnect: a surviving agent loses its sub-agents until the replay recreates the live ones', () => {
  const os = new OfficeState();
  os.addAgent(1);
  os.addSubagent(1, 'toolu_finished');

  resetSurvivingStatus(os, [1]);

  assert.equal(os.getSubagentId(1, 'toolu_finished'), null);
});

test('reconnect: only a snapshot from another server process counts as a new server', () => {
  const seen = {};
  assert.equal(isNewServer(seen, 'boot-a'), false, 'the first snapshot');
  assert.equal(isNewServer(seen, 'boot-a'), false, 'a reconnect to the same server');
  assert.equal(isNewServer(seen, undefined), false, 'a server that sends no id');
  assert.equal(isNewServer(seen, 'boot-b'), true, 'a restarted server');
});
