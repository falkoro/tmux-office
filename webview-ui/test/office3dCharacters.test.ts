import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { ChoiceStore } from '../src/office3d/characterChoice.js';
import {
  aliasKey,
  applyAliases,
  loadCharacter,
  saveAlias,
  saveCharacter,
} from '../src/office3d/characterChoice.js';
import type { ActorKind, CharacterKind, CharacterMood } from '../src/office3d/characters.js';
import {
  CHARACTER_KINDS,
  CharacterKit,
  characterMoving,
  characterPose,
  defaultCharacterKind,
  nextIdleIn,
  POSE_SIZE,
} from '../src/office3d/characters.js';
import type { RoomModel } from '../src/office3d/model.js';

const MOODS: CharacterMood[] = ['work', 'alert', 'ask', 'cheer', 'rest', 'doze'];

function memoryStore(): ChoiceStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const blocked: ChoiceStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('default character', () => {
  test('the same name always gets the same kind', () => {
    // Literal kinds: a change to the name hash would give every desk a new default character.
    const kinds: Record<string, CharacterKind> = {
      'work-8': 'knight',
      'triage-c9': 'dog',
      'nightly-digest': 'astronaut',
      '': 'frog',
    };
    for (const [name, kind] of Object.entries(kinds)) {
      assert.equal(defaultCharacterKind(name), kind, name);
    }
  });

  test('kinds spread across names', () => {
    const counts = new Map<string, number>();
    const names = Array.from({ length: 900 }, (_, i) => `session-${i}-${(i * 7919) % 1000}`);
    for (const name of names) {
      const kind = defaultCharacterKind(name);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    assert.equal(counts.size, CHARACTER_KINDS.length);
    const expected = names.length / CHARACTER_KINDS.length;
    for (const [kind, n] of counts) {
      assert.ok(n > expected * 0.6 && n < expected * 1.4, `${kind}: ${n}`);
    }
  });
});

describe('character choice', () => {
  test('a pick survives a reload and the default clears it', () => {
    const store = memoryStore();
    const name = 'work-8';
    const other = CHARACTER_KINDS.find((k) => k !== defaultCharacterKind(name));
    assert.ok(other);
    assert.equal(loadCharacter(name, store), defaultCharacterKind(name));
    saveCharacter(name, other, store);
    assert.equal(loadCharacter(name, store), other);
    saveCharacter(name, defaultCharacterKind(name), store);
    assert.equal(store.data.size, 0);
  });

  test('blocked or missing storage falls back to the default and never throws', () => {
    assert.equal(loadCharacter('ops', blocked), defaultCharacterKind('ops'));
    assert.doesNotThrow(() => saveCharacter('ops', 'frog', blocked));
    assert.equal(loadCharacter('ops', null), defaultCharacterKind('ops'));
    assert.doesNotThrow(() => saveCharacter('ops', 'frog', null));
  });

  test('a stored value that is not a kind is ignored', () => {
    const store = memoryStore();
    store.setItem('pixel-agents.office3d.character:ops', 'dragon');
    assert.equal(loadCharacter('ops', store), defaultCharacterKind('ops'));
  });

  test('goblins are kept for helpers, so a desk never becomes one', () => {
    assert.ok(!(CHARACTER_KINDS as readonly string[]).includes('goblin'));
    const store = memoryStore();
    store.setItem('pixel-agents.office3d.character:ops', 'goblin');
    assert.equal(loadCharacter('ops', store), defaultCharacterKind('ops'));
  });
});

describe('renaming', () => {
  const office = (): RoomModel[] => [
    {
      id: 'work',
      title: 'work',
      pods: [
        {
          id: 'work-4',
          title: 'work-4',
          pinned: false,
          hasOverseer: true,
          desks: [
            {
              agentId: 1,
              name: 'fm-oss-nm-update-unit-refresh',
              label: 'fm oss nm update unit refresh',
              pane: null,
              status: 'idle',
              tool: null,
              contextRatio: 0,
              helpers: [],
            },
          ],
        },
      ],
    },
  ];

  test('names a viewer picks replace the labels until cleared', () => {
    const store = memoryStore();
    saveAlias(aliasKey('pod', 'work-4'), 'oss crew', store);
    saveAlias(aliasKey('desk', 'fm-oss-nm-update-unit-refresh'), 'unit refresh', store);
    const named = office();
    applyAliases(named, store);
    assert.equal(named[0].pods[0].title, 'oss crew');
    assert.equal(named[0].pods[0].desks[0].label, 'unit refresh');
    assert.equal(named[0].pods[0].desks[0].name, 'fm-oss-nm-update-unit-refresh');

    saveAlias(aliasKey('pod', 'work-4'), '', store);
    const cleared = office();
    applyAliases(cleared, store);
    assert.equal(cleared[0].pods[0].title, 'work-4');
  });

  test("a room that is one session shows that session's name in the bar", () => {
    const store = memoryStore();
    const solo = office();
    solo[0].pods[0].id = 'work';
    saveAlias(aliasKey('pod', 'work'), 'oss crew', store);
    applyAliases(solo, store);
    assert.equal(solo[0].title, 'oss crew');
    const shared = office();
    applyAliases(shared, store);
    assert.equal(shared[0].title, 'work');
  });

  test('blocked storage keeps the tmux names', () => {
    const rooms = office();
    saveAlias(aliasKey('pod', 'work-4'), 'oss crew', blocked);
    applyAliases(rooms, blocked);
    assert.equal(rooms[0].pods[0].title, 'work-4');
  });
});

describe('poses', () => {
  const pose = (mood: CharacterMood, t: number, reduced: boolean, seated = true) => {
    const out = new Float32Array(POSE_SIZE);
    characterPose('cat', mood, t, t, 0.3, { seated, reduced }, out);
    return [...out];
  };

  test('reduced motion holds every pose still', () => {
    for (const mood of MOODS) {
      for (const seated of [true, false]) {
        assert.deepEqual(pose(mood, 0.1, true, seated), pose(mood, 4.7, true, seated), mood);
      }
      assert.equal(characterMoving(mood, 0.5, 0.3, true), false);
    }
  });

  test('reduced motion keeps the status poses apart', () => {
    const still = MOODS.filter((m) => m !== 'cheer').map((m) => JSON.stringify(pose(m, 0, true)));
    assert.equal(new Set(still).size, still.length);
  });

  test('a working goblin swings a hammer where the others type', () => {
    const swing = (kind: ActorKind) => {
      const lo = new Float32Array(POSE_SIZE).fill(Infinity);
      const hi = new Float32Array(POSE_SIZE).fill(-Infinity);
      const out = new Float32Array(POSE_SIZE);
      for (let t = 0; t < 1; t += 0.02) {
        characterPose(kind, 'work', t, t, 0.3, { seated: false, reduced: false }, out);
        out.forEach((v, i) => {
          lo[i] = Math.min(lo[i], v);
          hi[i] = Math.max(hi[i], v);
        });
      }
      return Math.max(...hi.map((v, i) => v - lo[i]));
    };
    assert.ok(swing('goblin') > 1.5, `goblin swing ${swing('goblin')}`);
    for (const kind of CHARACTER_KINDS) assert.ok(swing(kind) < 0.5, `${kind} ${swing(kind)}`);
  });

  test('work types, and a calm office eventually stops moving', () => {
    assert.notDeepEqual(pose('work', 0.1, false), pose('work', 0.2, false));
    assert.ok(characterMoving('work', 3, 0.3, false));
    let t = 2;
    if (nextIdleIn(t, 0.3) === 0) t += 1.5;
    assert.equal(characterMoving('doze', t, 0.3, false), false);
    assert.ok(characterMoving('doze', t + nextIdleIn(t, 0.3) + 0.01, 0.3, false));
  });
});

describe('kit', () => {
  test('every kind and colourway builds one skinned mesh', () => {
    const kit = new CharacterKit();
    for (const kind of [...CHARACTER_KINDS, 'goblin'] as const) {
      for (const variant of [0, 1, 2]) {
        const character = kit.create(kind, variant);
        const geo = character.mesh.geometry;
        assert.ok(geo.attributes.skinIndex && geo.attributes.color, kind);
        assert.equal(character.mesh.skeleton.bones.length, 10);
        const out = new Float32Array(POSE_SIZE);
        characterPose(kind, 'alert', 1, 1, 0.5, { seated: true, reduced: false }, out);
        character.apply(out);
        character.dispose();
      }
    }
    kit.dispose();
  });
});
