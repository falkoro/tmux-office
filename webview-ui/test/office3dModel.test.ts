import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  matchesRoomPattern,
  parseBackground,
  parseRoomConfig,
} from '../../core/src/roomPatterns.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { Character } from '../src/office/types.js';
import type { TerminalMeta } from '../src/office3d/model.js';
import type { OfficeConfig } from '../src/office3d/model.js';
import {
  BACKGROUND_ROOM_ID,
  deriveOffice,
  deskStatus,
  type Focus,
  focusFromHash,
  focusHash,
  FocusLink,
  naturalCompare,
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

function cfg(
  rooms: OfficeConfig['rooms'],
  pinned: string[] = [],
  background = true,
  overseers: string[] = [],
): OfficeConfig {
  return { rooms, pinned, overseers, background };
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
      char(1, { tmux: pane('work-10') }),
      char(2, { tmux: pane('work-2') }),
      char(3, { tmux: pane('work-8') }),
      char(4, { tmux: pane('work-2', '@7') }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['work-2', 'work-8', 'work-10'],
    );
    assert.deepEqual(
      roomDesks(rooms[0]).map((d) => d.agentId),
      [2, 4],
    );
    assert.equal(rooms[0].title, 'work-2');
  });

  test("an inline teammate in its lead's pane is named by its own agent name", () => {
    const lead = pane('work-3', '@4', '%7');
    const chars = [
      char(1, { folderName: 'repo' }),
      char(2, { agentName: 'researcher', folderName: 'repo' }),
    ];
    const terminals: Record<number, TerminalMeta> = {
      1: { name: 'zeta-c9', tmux: lead },
      2: { name: null, tmux: lead },
    };
    const desks = roomDesks(deriveOffice(chars, terminals)[0]);
    assert.deepEqual(
      desks.map((d) => d.name),
      ['zeta-c9', 'researcher'],
    );
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
      char(1, { tmux: pane('work-1') }),
      char(2, { tmux: pane('ops') }),
      char(3, { folderName: 'nightly' }),
    ];
    const rooms = deriveOffice(
      chars,
      {},
      {},
      cfg([{ name: 'work', patterns: ['work-*'] }], [], false),
    );
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['work'],
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
    const terminals = { 1: { name: 'on-call-b4', tmux: pane('work-8') } };
    const [room] = deriveOffice(chars, terminals);
    assert.equal(room.id, 'work-8');
    assert.equal(roomDesks(room)[0].name, 'on-call-b4');
    assert.deepEqual(roomDesks(room)[0].pane, pane('work-8'));
  });

  test('a terminal entry with no pane sends the agent to the background', () => {
    const chars = [char(1, { tmux: pane('gone') })];
    const rooms = deriveOffice(chars, { 1: { name: null, tmux: null } });
    assert.equal(rooms[0].id, BACKGROUND_ROOM_ID);
  });

  test('one named room collects desks from several matching sessions in session order', () => {
    const chars = [
      char(1, { tmux: pane('work-10', '@1', '%1') }),
      char(2, { tmux: pane('work-2', '@3', '%2') }),
      char(6, { tmux: pane('work-2', '@1', '%1') }),
      char(3, { tmux: pane('work-2', '@1', '%1') }),
      char(5, { tmux: pane('work-2', '@1', '%9') }),
      char(4, { tmux: pane('work-8', '@2', '%1') }),
    ];
    const rooms = deriveOffice(chars, {}, {}, cfg([{ name: 'work', patterns: ['work-*'] }]));
    assert.deepEqual(
      rooms.map((r) => [r.id, r.title]),
      [['work', 'work']],
    );
    assert.deepEqual(
      roomDesks(rooms[0]).map((d) => d.agentId),
      [3, 6, 5, 2, 4, 1],
    );
  });

  test('an empty configured room is still present', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('work-2') })],
      {},
      {},
      cfg([
        { name: 'work', patterns: ['work-*'] },
        { name: 'lab', patterns: ['lab-*'] },
      ]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['work', [1]],
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
      [char(1, { tmux: pane('work-2') })],
      {},
      {},
      cfg([
        { name: 'all', patterns: ['*'] },
        { name: 'work', patterns: ['work-*'] },
      ]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['all', [1]],
        ['work', []],
      ],
    );
  });

  test('a non-matching session goes to the Background', () => {
    const rooms = deriveOffice(
      [char(1, { tmux: pane('scratch') }), char(2, { tmux: pane('work-1') }), char(3)],
      {},
      {},
      cfg([{ name: 'work', patterns: ['work-*'] }]),
    );
    assert.deepEqual(
      rooms.map((r) => [r.id, roomDesks(r).map((d) => d.agentId)]),
      [
        ['work', [2]],
        [BACKGROUND_ROOM_ID, [1, 3]],
      ],
    );
  });

  test('a named room splits into session pods, pinned first, then natural order', () => {
    const rooms = deriveOffice(
      [
        char(1, { tmux: pane('work-10') }),
        char(2, { tmux: pane('work-8') }),
        char(3, { tmux: pane('work-2', '@2') }),
        char(4, { tmux: pane('work-2', '@1') }),
      ],
      {},
      {},
      cfg([{ name: 'work', patterns: ['work-*'] }], ['work-8']),
    );
    assert.deepEqual(
      rooms[0].pods.map((p) => [p.id, p.pinned, p.desks.map((d) => d.agentId)]),
      [
        ['work-8', true, [2]],
        ['work-2', false, [4, 3]],
        ['work-10', false, [1]],
      ],
    );
  });

  test('a session is led by its first agent whose name matches an overseer glob, else its oldest window', () => {
    const chars = [
      char(1, { tmux: pane('work-1', '@1') }),
      char(2, { tmux: pane('work-1', '@2') }),
      char(3, { tmux: pane('work-1', '@3') }),
      char(4, { tmux: pane('work-2', '@4') }),
      char(5, { tmux: pane('work-2', '@5') }),
    ];
    const terminals: Record<number, TerminalMeta> = {
      1: { name: 'crew-a', tmux: pane('work-1', '@1') },
      2: { name: 'lead-b', tmux: pane('work-1', '@2') },
      3: { name: 'lead-c', tmux: pane('work-1', '@3') },
      4: { name: 'crew-d', tmux: pane('work-2', '@4') },
      5: { name: 'crew-e', tmux: pane('work-2', '@5') },
    };
    const work = cfg([{ name: 'work', patterns: ['work-*'] }], [], true, ['lead-*']);
    assert.deepEqual(
      deriveOffice(chars, terminals, {}, work)[0].pods.map((p) => [
        p.id,
        p.hasOverseer,
        p.desks.map((d) => d.name),
      ]),
      [
        ['work-1', true, ['lead-b', 'crew-a', 'lead-c']],
        ['work-2', true, ['crew-d', 'crew-e']],
      ],
    );
    assert.deepEqual(
      deriveOffice(chars, terminals, {}, null)[0].pods[0].desks.map((d) => d.name),
      ['crew-a', 'lead-b', 'lead-c'],
    );
  });

  test('a card label drops the hex id and the overseer role, unless two labels would match', () => {
    const names = [
      'lead-api-e9',
      'fix-login-1d',
      'docs-62',
      'docs-b4',
      'lead-3f',
      'run-v2',
      'fix-bad',
      'add-cafe',
      'web-2024',
      'build-ok',
      'build_ok-2e',
      'stage-ok',
      'stage_ok',
    ];
    const chars = names.map((_, i) => char(i + 1, { tmux: pane(`work-${i}`, `@${i}`) }));
    chars[1].tmux = pane('work-0', '@9');
    const terminals: Record<number, TerminalMeta> = Object.fromEntries(
      names.map((name, i) => [i + 1, { name, tmux: chars[i].tmux ?? null }]),
    );
    const labels = deriveOffice(chars, terminals, {}, cfg([], [], true, ['lead-*']))
      .flatMap((room) => room.pods.flatMap((pod) => pod.desks))
      .map((d) => [d.name, d.label] as const);
    assert.deepEqual(
      new Map(labels),
      new Map([
        ['lead-api-e9', 'api'],
        ['fix-login-1d', 'fix login'],
        ['docs-62', 'docs 62'],
        ['docs-b4', 'docs b4'],
        ['lead-3f', 'lead'],
        ['run-v2', 'run v2'],
        ['fix-bad', 'fix bad'],
        ['add-cafe', 'add cafe'],
        ['web-2024', 'web 2024'],
        ['build-ok', 'build ok'],
        ['build_ok-2e', 'build ok 2e'],
        ['stage-ok', 'stage-ok'],
        ['stage_ok', 'stage_ok'],
      ]),
    );
    const leads = ['leader-c9', 'lead-ops-4a'];
    const leadChars = leads.map((_, i) => char(i + 1, { tmux: pane(`team-${i}`, `@${i}`) }));
    const leadTerminals: Record<number, TerminalMeta> = Object.fromEntries(
      leads.map((name, i) => [i + 1, { name, tmux: leadChars[i].tmux ?? null }]),
    );
    assert.deepEqual(
      deriveOffice(leadChars, leadTerminals, {}, cfg([], [], true, ['lead*']))
        .flatMap((room) => room.pods.flatMap((pod) => pod.desks))
        .map((d) => d.label),
      ['leader', 'ops'],
    );
  });

  test('a whole name taken to break a clash never matches another card', () => {
    const names = ['api-0a', 'api-0b', 'api-0a-ff'];
    const chars = names.map((_, i) => char(i + 1, { tmux: pane(`work-${i}`, `@${i}`) }));
    const terminals: Record<number, TerminalMeta> = Object.fromEntries(
      names.map((name, i) => [i + 1, { name, tmux: chars[i].tmux ?? null }]),
    );
    const labels = deriveOffice(chars, terminals, {}, cfg([], [], true, []))
      .flatMap((room) => room.pods.flatMap((pod) => pod.desks))
      .map((d) => [d.name, d.label] as const);
    assert.deepEqual(
      new Map(labels),
      new Map([
        ['api-0a', 'api 0a'],
        ['api-0b', 'api 0b'],
        ['api-0a-ff', 'api 0a ff'],
      ]),
    );
  });

  test('agents without a pane share one pod, last in the background', () => {
    const rooms = deriveOffice(
      [char(3), char(2, { tmux: pane('scratch') }), char(1)],
      {},
      {},
      cfg([{ name: 'work', patterns: ['work-*'] }]),
    );
    assert.deepEqual(
      rooms[rooms.length - 1].pods.map((p) => [p.id, p.hasOverseer, p.desks.map((d) => d.agentId)]),
      [
        ['scratch', true, [2]],
        [NO_PANE_POD_ID, false, [1, 3]],
      ],
    );
  });

  test('pins work without named rooms, keep room order, and never pin the no-pane pod', () => {
    const chars = [char(1, { tmux: pane('work-8') }), char(2, { tmux: pane('work-1') }), char(3)];
    const pinsOf = (pinned: string[]) =>
      deriveOffice(chars, {}, {}, cfg([], pinned)).map((r) => [r.id, r.pods.map((p) => p.pinned)]);
    assert.deepEqual(pinsOf(['work-8']), [
      ['work-1', [false]],
      ['work-8', [true]],
      [BACKGROUND_ROOM_ID, [false]],
    ]);
    assert.deepEqual(pinsOf(['*']), [
      ['work-1', [true]],
      ['work-8', [true]],
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

describe('3D agent removal', () => {
  test('a removed agent leaves the office and a returning id sits down again', () => {
    const os = new OfficeState();
    os.addAgent(1);
    os.removeAgent(1);
    os.finishDespawns();
    assert.equal(os.characters.has(1), false);
    os.addAgent(1);
    os.finishDespawns();
    const desks = deriveOffice(os.characters.values(), {}).flatMap(roomDesks);
    assert.deepEqual(
      desks.map((d) => d.agentId),
      [1],
    );
  });
});

describe('focus hash', () => {
  // The session `work` lands in misc, next to a room that is also called work.
  const office = deriveOffice(
    [char(1), char(2)],
    { 1: { name: 'a', tmux: pane('work-1') }, 2: { name: 'b', tmux: pane('work', '@1', '%2') } },
    {},
    cfg([
      { name: 'work', patterns: ['work-*'] },
      { name: 'misc', patterns: ['*'] },
    ]),
  );

  test('names a room by its name and a session by its name', () => {
    assert.deepEqual(focusFromHash(office, 'work'), { kind: 'room', id: 'work' });
    assert.deepEqual(focusFromHash(office, 'work-1'), { kind: 'pod', id: 'work-1' });
    assert.equal(focusHash(office, { kind: 'pod', id: 'work-1' }), 'work-1');
    assert.equal(focusFromHash(office, 'gone'), null);
  });

  test('round-trips a session that shares its name with a room', () => {
    const targets: Focus[] = [
      { kind: 'room', id: 'work' },
      { kind: 'pod', id: 'work' },
      { kind: 'pod', id: 'work-1' },
    ];
    for (const focus of targets) {
      assert.deepEqual(focusFromHash(office, focusHash(office, focus)), focus);
    }
  });
});

describe('FocusLink', () => {
  const office = (...sessions: string[]) =>
    deriveOffice(
      sessions.map((_, i) => char(i + 1)),
      Object.fromEntries(
        sessions.map((s, i) => [i + 1, { name: s, tmux: pane(s, '@1', `%${i + 1}`) }]),
      ),
      {},
      cfg([{ name: 'work', patterns: ['work-*'] }]),
    );

  test('keeps a deep link while its session drops out for a poll', () => {
    const link = new FocusLink('work-3');
    assert.equal(link.resolve(office('work-1', 'work-3')), true);
    assert.deepEqual(link.focus, { kind: 'pod', id: 'work-3' });
    assert.equal(link.resolve(office('work-1')), false);
    assert.deepEqual(link.focus, { kind: 'pod', id: 'work-3' });
    assert.equal(link.resolve(office('work-1', 'work-3')), false);
    assert.deepEqual(link.focus, { kind: 'pod', id: 'work-3' });
    assert.equal(link.hash, 'work-3');
  });

  test('pointing the link somewhere missing drops the old focus', () => {
    const link = new FocusLink('work-3');
    link.resolve(office('work-1', 'work-3'));
    link.point('work-9', office('work-1', 'work-3'));
    assert.equal(link.focus, null);
    link.point('work-1', office('work-1', 'work-3'));
    assert.deepEqual(link.focus, { kind: 'pod', id: 'work-1' });
    link.point(null, office('work-1'));
    assert.equal(link.focus, null);
  });
});

describe('naturalCompare', () => {
  test('orders numbers by value and ties no two different names', () => {
    assert.ok(naturalCompare('work-2', 'work-10') < 0);
    for (const [a, b] of [
      ['work-1', 'work-01'],
      ['Work', 'work'],
    ]) {
      assert.notEqual(naturalCompare(a, b), 0, `${a} vs ${b}`);
      assert.deepEqual([a, b].sort(naturalCompare), [b, a].sort(naturalCompare));
    }
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
    assert.deepEqual(parseRoomConfig('work=work-*'), [{ name: 'work', patterns: ['work-*'] }]);
    assert.deepEqual(parseRoomConfig('work-*'), [{ name: 'work-*', patterns: ['work-*'] }]);
    assert.deepEqual(parseRoomConfig('work=work-*; lab=lab-*,scratch'), [
      { name: 'work', patterns: ['work-*'] },
      { name: 'lab', patterns: ['lab-*', 'scratch'] },
    ]);
    assert.deepEqual(parseRoomConfig(' work = work-* ; ; lab = lab-* scratch '), [
      { name: 'work', patterns: ['work-*'] },
      { name: 'lab', patterns: ['lab-*', 'scratch'] },
    ]);
    assert.deepEqual(parseRoomConfig('work=; =scratch; bare'), [
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
    assert.ok(matchesRoomPattern(['work-*'], 'work-8'));
    assert.ok(matchesRoomPattern(['work-*'], 'work-'));
    assert.ok(!matchesRoomPattern(['work-*'], 'my-work-8'));
    assert.ok(matchesRoomPattern(['a.b'], 'a.b'));
    assert.ok(!matchesRoomPattern(['a.b'], 'axb'));
    assert.ok(!matchesRoomPattern([], 'work-8'));
  });
});
