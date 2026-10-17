import { Group, PerspectiveCamera } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { DeskModel } from '../src/office3d/model.js';

function fakeElement(): unknown {
  return {
    style: { setProperty: () => undefined } as Record<string, unknown>,
    dataset: {},
    options: [],
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

const kit = {
  create: () => ({ mesh: new Group(), apply: () => undefined, dispose: () => undefined }),
};

describe('DeskView walk-mode screening', () => {
  beforeAll(() => {
    vi.stubGlobal('document', { createElement: fakeElement });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test('a desk screened out at eye level hides its status badge and its helpers’ badges with its card', async () => {
    const { DeskView } = await import('../src/office3d/scene.js');
    const model: DeskModel = {
      agentId: 1,
      name: 'api-refactor-e9',
      label: 'api refactor',
      pane: null,
      status: 'needs-permission',
      tool: null,
      contextRatio: 0,
      helpers: [{ agentId: -1, status: 'needs-permission', tool: null }],
    };
    const ctx = { kit, kindFor: () => 'human' } as unknown as ConstructorParameters<
      typeof DeskView
    >[0];
    const desk = new DeskView(ctx, model);
    desk.apply(model, false, 0, true);
    desk.group.updateMatrixWorld(true);
    const camera = new PerspectiveCamera();
    camera.position.set(0, 1.6, 8);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld();

    const visibility = (): string[] => {
      const out: string[] = [];
      desk.group.traverse((o) => {
        if (o instanceof CSS2DObject) {
          out.push(
            String((o.element as unknown as { style: Record<string, unknown> }).style.visibility),
          );
        }
      });
      return out;
    };

    desk.scaleLabel(500, camera, () => true);
    expect(visibility()).toEqual(['hidden', 'hidden', 'hidden']);

    desk.scaleLabel(500, camera, null);
    expect(visibility()).toEqual(['', '', '']);
  });
});
