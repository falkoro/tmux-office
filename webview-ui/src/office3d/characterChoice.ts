import { OFFICE3D_ALIAS_KEY, OFFICE3D_CHARACTER_KEY } from '../constants.js';
import type { CharacterKind } from './characters.js';
import { defaultCharacterKind, isCharacterKind } from './characters.js';
import type { RoomModel } from './model.js';

export type ChoiceStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or null where the page may not touch it (privacy modes, sandboxed frames). */
function browserStore(): ChoiceStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The character this viewer picked for a desk name, or the name's default. */
export function loadCharacter(name: string, store = browserStore()): CharacterKind {
  try {
    const stored = store?.getItem(OFFICE3D_CHARACTER_KEY + name);
    if (isCharacterKind(stored)) return stored;
  } catch {
    // Blocked storage reads as "never chosen".
  }
  return defaultCharacterKind(name);
}

/** Remember a pick for this viewer. Picking the default forgets the entry. */
export function saveCharacter(name: string, kind: CharacterKind, store = browserStore()): void {
  try {
    if (kind === defaultCharacterKind(name)) store?.removeItem(OFFICE3D_CHARACTER_KEY + name);
    else store?.setItem(OFFICE3D_CHARACTER_KEY + name, kind);
  } catch {
    // The pick still applies until the page reloads.
  }
}

/** What a viewer can rename: a desk by its agent's name, a session by its tmux name. */
export function aliasKey(kind: 'desk' | 'pod', id: string): string {
  return `${OFFICE3D_ALIAS_KEY}${kind}:${id}`;
}

/** Remember a name for this viewer. An empty name forgets it. */
export function saveAlias(key: string, name: string, store = browserStore()): void {
  try {
    if (name) store?.setItem(key, name);
    else store?.removeItem(key);
  } catch {
    // Blocked storage keeps the old name.
  }
}

/** The name this viewer gave, or null. */
export function loadAlias(key: string, store = browserStore()): string | null {
  try {
    return store?.getItem(key) || null;
  } catch {
    return null;
  }
}

/** Show this viewer's names on desk cards and session signs. Keys stay the real names. */
export function applyAliases(rooms: RoomModel[], store = browserStore()): void {
  for (const room of rooms) {
    for (const pod of room.pods) {
      pod.title = loadAlias(aliasKey('pod', pod.id), store) ?? pod.title;
      for (const desk of pod.desks)
        desk.label = loadAlias(aliasKey('desk', desk.name), store) ?? desk.label;
    }
    if (room.pods.length === 1 && room.pods[0].id === room.id) {
      room.title = loadAlias(aliasKey('pod', room.id), store) ?? room.title;
    }
  }
}
