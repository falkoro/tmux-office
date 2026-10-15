import { OFFICE3D_CHARACTER_KEY } from '../constants.js';
import type { CharacterKind } from './characters.js';
import { defaultCharacterKind, isCharacterKind } from './characters.js';

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
