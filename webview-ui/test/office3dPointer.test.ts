import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

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

describe('OfficeScene pointer gestures', () => {
  beforeAll(() => {
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      location: { hash: '', search: '' },
      matchMedia: () => ({ matches: true, addEventListener: () => undefined }),
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
});
