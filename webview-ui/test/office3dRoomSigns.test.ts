import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { PodModel, RoomModel } from '../src/office3d/model.js';

function fakeElement(): unknown {
  return {
    style: { setProperty: () => undefined },
    dataset: {},
    className: '',
    textContent: '',
    title: '',
    type: '',
    append: () => undefined,
    remove: () => undefined,
    replaceChildren: () => undefined,
    setAttribute: () => undefined,
    addEventListener: () => undefined,
  };
}

function pod(id: string): PodModel {
  return { id, title: id, pinned: false, hasOverseer: false, desks: [] };
}

describe('RoomView pod signs', () => {
  beforeAll(() => {
    vi.stubGlobal('document', { createElement: fakeElement });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  async function signsAfterLabelPass(room: RoomModel): Promise<boolean[]> {
    const { RoomView } = await import('../src/office3d/scene.js');
    const view = new RoomView({} as ConstructorParameters<typeof RoomView>[0], room.id, false);
    view.apply(room);
    view.screen(null);
    return view.group.children
      .filter(
        (o) => (o as unknown as { element: { className: string } }).element.className === 'o3d-pod',
      )
      .map((o) => o.visible);
  }

  test('a room that is just its one session keeps its sign hidden after a label pass', async () => {
    expect(
      await signsAfterLabelPass({ id: 'work-3', title: 'work-3', pods: [pod('work-3')] }),
    ).toEqual([false]);
  });

  test('a room of several sessions shows a sign for each', async () => {
    expect(
      await signsAfterLabelPass({
        id: 'build',
        title: 'build',
        pods: [pod('work-1'), pod('work-2')],
      }),
    ).toEqual([true, true]);
  });
});
