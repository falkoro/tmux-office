import type { Box3 } from 'three';
import { Group, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { OFFICE3D_WALK_EYE_Y } from '../src/constants.js';
import type { DeskModel } from '../src/office3d/model.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement = fakeElement();
    shadowMap = {};
    setPixelRatio(): void {}
    setSize(): void {}
  }
  class FakeCubeCamera {
    update(): void {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer, CubeCamera: FakeCubeCamera };
});
vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return {
    OrbitControls: class {
      target = new Vector3();
      addEventListener(): void {}
      update(): void {}
      dispose(): void {}
    },
  };
});
vi.mock('three/addons/lights/LightProbeGenerator.js', () => ({
  LightProbeGenerator: { fromCubeRenderTarget: () => new Promise(() => undefined) },
}));

type Handler = (e: Record<string, unknown>) => void;

function fakeElement() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    style: { setProperty: () => undefined } as Record<string, unknown>,
    dataset: {},
    options: [],
    className: '',
    clientWidth: 800,
    clientHeight: 600,
    append: () => undefined,
    remove: () => undefined,
    setAttribute: () => undefined,
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    removeEventListener: () => undefined,
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

let reducedMotion = true;

describe('OfficeScene pointer gestures', () => {
  beforeAll(() => {
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      location: { hash: '', search: '' },
      matchMedia: () => ({ matches: reducedMotion, addEventListener: () => undefined }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('document', {
      hidden: true,
      createElement: fakeElement,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test('a two-finger pinch over the overhead view never picks the desk under a finger', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    vi.spyOn(OfficeScene.prototype as unknown as { pick: () => number }, 'pick').mockReturnValue(7);
    const picks: number[] = [];
    const host = fakeElement();
    const scene = new OfficeScene(host as unknown as HTMLElement, {
      onPick: (id) => picks.push(id),
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const canvas = (
      scene as unknown as { renderer: { domElement: ReturnType<typeof fakeElement> } }
    ).renderer.domElement;
    const fire = (type: string, pointerId: number, x: number) =>
      canvas.handlers.get(type)!({
        pointerId,
        clientX: x,
        clientY: 300,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
      });

    fire('pointerdown', 1, 300);
    fire('pointerdown', 2, 500);
    fire('pointermove', 1, 200);
    fire('pointermove', 1, 100);
    fire('pointerup', 1, 100);
    fire('pointerup', 2, 500);

    expect(picks).toEqual([]);
  });

  test('a two-finger tap in walk mode never picks the desk under a finger', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    vi.spyOn(OfficeScene.prototype as unknown as { pick: () => number }, 'pick').mockReturnValue(7);
    const picks: number[] = [];
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: (id) => picks.push(id),
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const canvas = (
      scene as unknown as { renderer: { domElement: ReturnType<typeof fakeElement> } }
    ).renderer.domElement;
    const captured = new Set<number>();
    Object.assign(canvas, {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    });
    const fire = (type: string, pointerId: number, x: number) =>
      canvas.handlers.get(type)!({
        pointerId,
        clientX: x,
        clientY: 300,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
      });
    scene.toggleWalk();

    fire('pointerdown', 1, 300);
    fire('pointerdown', 2, 500);
    fire('pointerup', 1, 300);
    fire('pointerup', 2, 500);

    expect(picks).toEqual([]);
  });

  test('a wheel turn while leaving walk mode lets the glide back up finish', async () => {
    reducedMotion = false;
    try {
      const { OfficeScene } = await import('../src/office3d/scene.js');
      const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
        onPick: () => undefined,
        onFocus: () => undefined,
        onWalk: () => undefined,
      });
      const inner = scene as unknown as {
        tween: unknown;
        renderer: { domElement: ReturnType<typeof fakeElement> };
      };
      scene.toggleWalk();
      scene.toggleWalk();
      expect(inner.tween).not.toBeNull();

      inner.renderer.domElement.handlers.get('wheel')!({});

      expect(inner.tween).not.toBeNull();
    } finally {
      reducedMotion = true;
    }
  });

  test('at eye level a desk hides labels behind it only up to its seated crown', async () => {
    const { DeskView, OfficeScene } = await import('../src/office3d/scene.js');
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: () => undefined,
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const model: DeskModel = {
      agentId: 1,
      name: 'front',
      label: 'front',
      pane: null,
      status: 'idle',
      tool: null,
      contextRatio: 0,
      helpers: [],
    };
    const kit = {
      create: () => ({ mesh: new Group(), apply: () => undefined, dispose: () => undefined }),
    };
    const ctx = { kit, kindFor: () => 'human' } as unknown as ConstructorParameters<
      typeof DeskView
    >[0];
    const desk = new DeskView(ctx, model);
    desk.place({ agentId: 1, x: 0, z: 0, scale: 1, overseer: true }, false);
    const inner = scene as unknown as {
      camera: { position: Vector3 };
      deskList: unknown[];
      screened: (at: Vector3, own: Box3 | null) => boolean;
    };
    inner.deskList = [desk];
    inner.camera.position.set(0, OFFICE3D_WALK_EYE_Y, 1.6);

    expect(inner.screened(new Vector3(0, 1.3, -7), null)).toBe(false);
    expect(inner.screened(new Vector3(0, 0.5, -3), null)).toBe(true);
  });
});
