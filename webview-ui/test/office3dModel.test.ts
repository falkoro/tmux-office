import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  matchesRoomPattern,
  parseBackground,
  parseRoomConfig,
} from '../../core/src/roomPatterns.js';
import type { Character } from '../src/office/types.js';
import type { TerminalMeta } from '../src/office3d/model.js';
import type { OfficeConfig } from '../src/office3d/model.js';
import {
  BACKGROUND_ROOM_ID,
  deriveOffice,
  deskStatus,
  NO_PANE_POD_ID,
  roomDesks,
  roomHeat,
} from '../src/office3d/model.js';

function char(id: number, extra: Partial<Character> = {}): Character {
  return {
    id,
    isActive: false,
    currentTool: null,
    bubbleType: null,
    isSubagent: false,
    parentAgentId: null,
    palette: 0,
    hueShift: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    matrixEffect: null,
    ...extra,
  } as Character;
}

function cfg(rooms: OfficeConfig['rooms'], pinned: string[] = [], background = true): OfficeConfig {
  return { rooms, pinned, background };
}

function pane(session: string, windowId = '@1', paneId = '%1'): TerminalMeta['tmux'] {
  return { session, windowId, paneId };
}

describe('deskStatus', () => {
  test('maps each bubble and activity combination', () => {
    assert.equal(deskStatus(char(1, { bubbleType: 'permission' })), 'needs-permission');
    assert.equal(
      deskStatus(char(1, { bubbleType: 'waiting', waitingAwaitingInput: true })),
      'waiting-input',
    );
    assert.equal(deskStatus(char(1, { bubbleType: 'waiting' })), 'done');
    assert.equal(
      deskStatus(char(1, { bubbleType: 'waiting', waitingAwaitingInput: false })),
      'done',
    );
    assert.equal(deskStatus(char(1, { isActive: true })), 'working');
    assert.equal(deskStatus(char(1)), 'idle');
  });

  test('a permission request mid-turn outranks working', () => {
    assert.equal(
      deskStatus(char(1, { isActive: true, bubbleType: 'permission' })),
      'needs-permission',
    );
  });

  test('a new turn outranks the previous turn-end bubble', () => {
    assert.equal(deskStatus(char(1, { isActive: true, bubbleType: 'waiting' })), 'working');
  });
});

describe('deriveOffice', () => {
  test('no config still gives one room per session in natural order', () => {
    const chars = [
      char(1, { tmux: pane('emperor-10') }),
      char(2, { tmux: pane('emperor-2') }),
      char(3, { tmux: pane('emperor-8') }),
      char(4, { tmux: pane('emperor-2', '@7') }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['emperor-2', 'emperor-8', 'emperor-10'],
    );
    assert.deepEqual(
      roomDesks(rooms[0]).map((d) => d.agentId),
      [2, 4],
    );
    assert.equal(rooms[0].title, 'emperor-2');
  });

  test('orders desks in a room by tmux window', () => {
    const chars = [
      char(1, { tmux: pane('s', '@12') }),
      char(2, { tmux: pane('s', '@3') }),
      char(3, { tmux: pane('s', '@3', '%9') }),
    ];
    const [room] = deriveOffice(chars, {});
    assert.deepEqual(
      roomDesks(room).map((d) => d.agentId),
      [2, 3, 1],
    );
  });

  test('puts agents without tmux in the background, last', () => {
    const chars = [
      char(5),
      char(1, { tmux: pane('zeta') }),
      char(3, { folderName: 'nightly' }),
      char(2, { tmux: pane('alpha') }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['alpha', 'zeta', BACKGROUND_ROOM_ID],
    );
    const last = rooms[rooms.length - 1];
    assert.equal(last.title, 'Background');
    assert.deepEqual(
      roomDesks(last).map((d) => d.agentId),
      [3, 5],
    );
    assert.equal(roomDesks(last)[0].pane, null);
  });

  test('a hidden background drops agents in no room', () => {
    const chars = [
      char(1, { tmux: pane('emperor-1') }),
      char(2, { tmux: pane('ops') }),
      char(3, { folderName: 'nightly' }),
    ];
    const rooms = deriveOffice(
      chars,
      {},
      {},
      cfg([{ name: 'emperor', patterns: ['emperor-*'] }], [], false),
    );
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['emperor'],
    );
    assert.deepEqual(
      roomDesks(rooms[0]).map((d) => d.agentId),
      [1],
    );
  });

  test('no background when every agent has a pane', () => {
    const rooms = deriveOffice([char(1, { tmux: pane('a') })], {});
    assert.equal(rooms.length, 1);
  });

  test('terminal metadata wins over the character copy', () => {
    const chars = [char(1, { tmux: pane('stale'), sessionName: 'old' })];
    const terminals = { 1: { name: 'on-call-b4', tmux: pane('emperor-8') } };
    const [room] = deriveOffice(chars, terminals);
    assert.equal(room.id, 'emperor-8');
    assert.equal(roomDesks(room)[0].name, 'on-call-b4');
    assert.deepEqual(roomDesks(room)[0].pane, pane('emperor-8'));
  });

  test('a terminal entry with no pane sends the agent to the background', () => {
    const chars = [char(1, { tmux: pane('gone') })];
    const rooms = deriveOffice(chars, { 1: { name: null, tmux: null } });
    assert.equal(rooms[0].id, BACKGROUND_ROOM_ID);
  });

  test('one named room collects desks from several matching sessions in session order', () => {
    const chars = [
      char(1, { tmux: pane('emperor-10', '@1', '%1') }),
      char(2, { tmux: pane('emperor-2', '@3', '%2') }),
      char(6, { tmux: pane('emperor-2', '@1', '%1') }),
      char(3, { tmux: pane('emperor-2', '@1', '%1') }),
      char(5, { tmux: pane('emperor-2', '@1', '%9') }),
      char(4, { tmux: pane('emperor-8', '@2', '%1') }),
    ];
    const rooms = deriveOffice(chars, {}, {}, cfg([{ name: 'emperor', patterns: ['emperor-*'] }]));
    assert.deepEqual(
      rooms.map((r) => [r.id, r.title]),
      [['emperor', 'emperor']],
    );
    assert.deepEqual(
      roomDesks(rooms[0]).map((d) => d.agentId),
      [3, 6, 5, 2, 4, 1],
    );
  });

  test('an empty configured room is still present', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('emperor-2') })],
      {},
      {},
      cfg([
        { name: 'emperor', patterns: ['emperor-*'] },
        { name: 'lab', patterns: ['lab-*'] },
      ]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['emperor', [1]],
        ['lab', []],
      ],
    );
  });

  test('config order is kept', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('alpha') }), char(2, { tmux: pane('zeta') })],
      {},
      {},
      cfg([
        { name: 'zeta', patterns: ['zeta'] },
        { name: 'alpha', patterns: ['alpha'] },
      ]),
    );
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['zeta', 'alpha'],
    );
  });

  test('the first matching room wins', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('emperor-2') })],
      {},
      {},
      cfg([
        { name: 'all', patterns: ['*'] },
        { name: 'emperor', patterns: ['emperor-*'] },
      ]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['all', [1]],
        ['emperor', []],
      ],
    );
  });

  test('a non-matching session goes to the Background', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('scratch') }), char(2, { tmux: pane('emperor-1') }), char(3)],
      {},
      {},
      cfg([{ name: 'emperor', patterns: ['emperor-*'] }]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['emperor', [2]],
        [BACKGROUND_ROOM_ID, [1, 3]],
      ],
    );
  });

  test('a named room splits into session pods, pinned first, then natural order', () => {
    const rooms = deriveOffice(
      [
        char(1, { tmux: pane('emperor-10') }),
        char(2, { tmux: pane('emperor-8') }),
        char(3, { tmux: pane('emperor-2', '@2') }),
        char(4, { tmux: pane('emperor-2', '@1') }),
      ],
      {},
      {},
      cfg([{ name: 'emperor', patterns: ['emperor-*'] }], ['emperor-8']),
    );
    assert.deepEqual(
      rooms[0].pods.map((p) => [p.id, p.pinned, p.desks.map((d) => d.agentId)]),
      [
        ['emperor-8', true, [2]],
        ['emperor-2', false, [4, 3]],
        ['emperor-10', false, [1]],
      ],
    );
  });

  test('agents without a pane share one pod, last in the background', () => {
    const rooms = deriveOffice(
      [char(3), char(2, { tmux: pane('scratch') }), char(1)],
      {},
      {},
      cfg([{ name: 'emperor', patterns: ['emperor-*'] }]),
    );
    assert.deepEqual(
      rooms[rooms.length - 1].pods.map((p) => [p.id, p.desks.map((d) => d.agentId)]),
      [
        ['scratch', [2]],
        [NO_PANE_POD_ID, [1, 3]],
      ],
    );
  });

  test('pins work without named rooms, keep room order, and never pin the no-pane pod', () => {
    const chars = [
      char(1, { tmux: pane('emperor-8') }),
      char(2, { tmux: pane('emperor-1') }),
      char(3),
    ];
    const pinsOf = (pinned: string[]) =>
      deriveOffice(chars, {}, {}, cfg([], pinned)).map((r) => [r.id, r.pods.map((p) => p.pinned)]);
    assert.deepEqual(pinsOf(['emperor-8']), [
      ['emperor-1', [false]],
      ['emperor-8', [true]],
      [BACKGROUND_ROOM_ID, [false]],
    ]);
    assert.deepEqual(pinsOf(['*']), [
      ['emperor-1', [true]],
      ['emperor-8', [true]],
      [BACKGROUND_ROOM_ID, [false]],
    ]);
  });

  test('names fall back from registry name to folder to agent id', () => {
    const chars = [char(1, { sessionName: 'reg' }), char(2, { folderName: 'repo' }), char(3)];
    const desks = roomDesks(deriveOffice(chars, {})[0]);
    assert.deepEqual(
      desks.map((d) => d.name),
      ['reg', 'repo', 'Agent 3'],
    );
  });

  test('sub-agents become helpers of their parent and never get a desk', () => {
    const chars = [
      char(1, { tmux: pane('s'), isActive: true }),
      char(-1, { isSubagent: true, parentAgentId: 1, isActive: true, currentTool: 'Read' }),
      char(-2, { isSubagent: true, parentAgentId: 1, bubbleType: 'permission' }),
      char(-3, { isSubagent: true, parentAgentId: 99 }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.equal(rooms.length, 1);
    assert.equal(roomDesks(rooms[0]).length, 1);
    assert.deepEqual(roomDesks(rooms[0])[0].helpers, [
      { agentId: -1, status: 'working', tool: 'Read' },
      { agentId: -2, status: 'needs-permission', tool: null },
    ]);
  });

  test('despawning characters are already gone', () => {
    const rooms = deriveOffice([char(1, { matrixEffect: 'despawn' })], {});
    assert.deepEqual(rooms, []);
  });

  test('activity text comes from the open tool, then the last one while working', () => {
    const chars = [
      char(1, { isActive: true, currentTool: 'Read' }),
      char(2, { isActive: true, currentTool: 'Edit' }),
      char(3, { isActive: true, currentTool: 'Bash' }),
      char(4, { currentTool: null }),
    ];
    const tools = {
      1: [
        { toolId: 'a', status: 'Reading App.tsx', done: true },
        { toolId: 'b', status: 'Editing model.ts', done: false },
      ],
      2: [{ toolId: 'c', status: 'Reading README.md', done: true }],
    };
    const desks = roomDesks(deriveOffice(chars, {}, tools)[0]);
    assert.deepEqual(
      desks.map((d) => d.tool),
      ['Editing model.ts', 'Reading README.md', 'Bash', null],
    );
  });

  test('an open question tool reads as waiting for you, an answered one as working', () => {
    const chars = [
      char(1, { isActive: true, currentTool: 'AskUserQuestion' }),
      char(2, { isActive: true, currentTool: 'AskUserQuestion' }),
      char(3, { isActive: true, bubbleType: 'permission' }),
    ];
    const tools = {
      1: [{ toolId: 'a', status: 'Waiting for your answer', done: false, question: true }],
      2: [{ toolId: 'b', status: 'Waiting for your answer', done: true, question: true }],
      3: [{ toolId: 'c', status: 'Waiting for your answer', done: false, question: true }],
    };
    const desks = roomDesks(deriveOffice(chars, {}, tools)[0]);
    assert.deepEqual(
      desks.map((d) => d.status),
      ['waiting-input', 'working', 'needs-permission'],
    );
  });

  test('context ratio is clamped and zero when the window is unknown', () => {
    const chars = [
      char(1, { contextTokens: 50, maxContextTokens: 200 }),
      char(2, { contextTokens: 300, maxContextTokens: 200 }),
      char(3, { contextTokens: 300, maxContextTokens: 0 }),
    ];
    const desks = roomDesks(deriveOffice(chars, {})[0]);
    assert.deepEqual(
      desks.map((d) => d.contextRatio),
      [0.25, 1, 0],
    );
  });
});

describe('roomHeat', () => {
  test('permission outranks waiting for input, which outranks calm', () => {
    const rooms = deriveOffice(
      [
        char(1, { tmux: pane('a'), bubbleType: 'waiting', waitingAwaitingInput: true }),
        char(2, { tmux: pane('a'), bubbleType: 'permission' }),
        char(3, { tmux: pane('b'), bubbleType: 'waiting', waitingAwaitingInput: true }),
        char(4, { tmux: pane('c'), isActive: true }),
        char(-1, { isSubagent: true, parentAgentId: 4, bubbleType: 'permission' }),
        char(5, { tmux: pane('d'), bubbleType: 'waiting' }),
      ],
      {},
    );
    assert.deepEqual(rooms.map(roomHeat), [
      'needs-permission',
      'waiting-input',
      'needs-permission',
      null,
    ]);
  });
});

describe('room patterns', () => {
  test('parseRoomConfig reads named rooms', () => {
    assert.deepEqual(parseRoomConfig('emperor=emperor-*'), [
      { name: 'emperor', patterns: ['emperor-*'] },
    ]);
    assert.deepEqual(parseRoomConfig('emperor-*'), [
      { name: 'emperor-*', patterns: ['emperor-*'] },
    ]);
    assert.deepEqual(parseRoomConfig('emperor=emperor-*; lab=lab-*,scratch'), [
      { name: 'emperor', patterns: ['emperor-*'] },
      { name: 'lab', patterns: ['lab-*', 'scratch'] },
    ]);
    assert.deepEqual(parseRoomConfig(' emperor = emperor-* ; ; lab = lab-* scratch '), [
      { name: 'emperor', patterns: ['emperor-*'] },
      { name: 'lab', patterns: ['lab-*', 'scratch'] },
    ]);
    assert.deepEqual(parseRoomConfig('emperor=; =scratch; bare'), [
      { name: 'bare', patterns: ['bare'] },
    ]);
    assert.deepEqual(parseRoomConfig(undefined), []);
  });

  test('parseBackground hides only on an explicit no', () => {
    for (const raw of ['hide', 'OFF', ' no ', 'false', '0'])
      assert.equal(parseBackground(raw), false, raw);
    for (const raw of [undefined, '', 'show', 'yes', '1', 'hidden'])
      assert.equal(parseBackground(raw), true, String(raw));
  });

  test('star matches any run and nothing else is special', () => {
    assert.ok(matchesRoomPattern(['emperor-*'], 'emperor-8'));
    assert.ok(matchesRoomPattern(['emperor-*'], 'emperor-'));
    assert.ok(!matchesRoomPattern(['emperor-*'], 'my-emperor-8'));
    assert.ok(matchesRoomPattern(['a.b'], 'a.b'));
    assert.ok(!matchesRoomPattern(['a.b'], 'axb'));
    assert.ok(!matchesRoomPattern([], 'emperor-8'));
  });
});
