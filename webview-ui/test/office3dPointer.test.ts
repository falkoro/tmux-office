import type { Box3 } from 'three';
import { Group, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { OFFICE3D_WALK_EYE_Y, OFFICE3D_WALK_PORCH } from '../src/constants.js';
import type { DeskModel } from '../src/office3d/model.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement = fakeElement();
    shadowMap = {};
    setPixelRatio(): void {}
    setSize(): void {}
    dispose(): void {}
    forceContextLoss(): void {}
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
const probe = vi.hoisted(() => ({
  bake: (): Promise<unknown> => new Promise(() => undefined),
}));
vi.mock('three/addons/lights/LightProbeGenerator.js', () => ({
  LightProbeGenerator: { fromCubeRenderTarget: () => probe.bake() },
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
    replaceChildren: () => undefined,
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
      matchMedia: () => ({
        matches: reducedMotion,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('document', {
      hidden: true,
      createElement: fakeElement,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
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

  test('a finger landing while another still holds never picks, even after the first lifts', async () => {
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
    const fire = (type: string, pointerId: number) =>
      canvas.handlers.get(type)!({
        pointerId,
        clientX: 300,
        clientY: 300,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
      });

    fire('pointerdown', 1);
    fire('pointerdown', 2);
    fire('pointerup', 1);
    fire('pointerdown', 3);
    fire('pointerup', 3);
    fire('pointerup', 2);
    expect(picks).toEqual([]);

    fire('pointerdown', 4);
    fire('pointerup', 4);
    expect(picks).toEqual([7]);
  });

  test('a cancelled finger no longer blocks the next tap', async () => {
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
    const fire = (type: string, pointerId: number) =>
      canvas.handlers.get(type)!({
        pointerId,
        clientX: 300,
        clientY: 300,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
      });

    fire('pointerdown', 1);
    fire('pointercancel', 1);
    fire('pointerdown', 2);
    fire('pointerup', 2);

    expect(picks).toEqual([7]);
  });

  test('a lost finger release does not block taps once a fresh touch starts', async () => {
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
    const fire = (type: string, pointerId: number, isPrimary: boolean) =>
      canvas.handlers.get(type)!({
        pointerId,
        isPrimary,
        clientX: 300,
        clientY: 300,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
      });

    fire('pointerdown', 1, true);
    fire('pointerdown', 2, true);
    fire('pointerup', 2, true);

    expect(picks).toEqual([7]);
  });

  test('a layout that shrinks the office pulls the walker back onto the floor', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: () => undefined,
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const inner = scene as unknown as {
      plan: { depth: number; width: number };
      walkX: number;
      walkZ: number;
      layout: () => void;
    };
    scene.toggleWalk();
    inner.walkZ = 1000;
    inner.walkX = 1000;

    inner.layout();

    expect(inner.walkZ).toBeLessThanOrEqual(inner.plan.depth / 2 + OFFICE3D_WALK_PORCH);
    expect(inner.walkX).toBeLessThanOrEqual(inner.plan.width / 2);
  });

  test('a walk entry glide that ends after the office shrank lands on the floor', async () => {
    reducedMotion = false;
    try {
      const { OfficeScene } = await import('../src/office3d/scene.js');
      const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
        onPick: () => undefined,
        onFocus: () => undefined,
        onWalk: () => undefined,
      });
      const inner = scene as unknown as {
        plan: unknown;
        tween: unknown;
        walkZ: number;
        layout: () => void;
        stepTween: (now: number) => boolean;
      };
      inner.plan = {
        rooms: [],
        columns: 1,
        narrow: false,
        width: 10,
        depth: 40,
      };
      scene.toggleWalk();
      expect(inner.tween).not.toBeNull();

      inner.layout();
      const floor = inner.plan as { depth: number };
      expect(floor.depth).toBeLessThan(40);
      inner.stepTween(Number.MAX_SAFE_INTEGER);

      expect(inner.tween).toBeNull();
      expect(inner.walkZ).toBeLessThanOrEqual(floor.depth / 2 + OFFICE3D_WALK_PORCH);
    } finally {
      reducedMotion = true;
    }
  });

  test('a finger tapping during a mouse look in walk mode neither ends the look nor picks', async () => {
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
    const fire = (type: string, pointerId: number, pointerType: string, x = 300) =>
      canvas.handlers.get(type)!({
        pointerId,
        pointerType,
        isPrimary: true,
        clientX: x,
        clientY: 300,
        button: 0,
        buttons: 1,
      });
    scene.toggleWalk();

    fire('pointerdown', 1, 'mouse');
    fire('pointerdown', 2, 'touch');
    fire('pointerup', 2, 'touch');
    expect(picks).toEqual([]);

    const inner = scene as unknown as { yaw: number };
    const yaw = inner.yaw;
    fire('pointermove', 1, 'mouse', 400);
    expect(inner.yaw).not.toBe(yaw);
    fire('pointerup', 1, 'mouse', 400);
    expect(picks).toEqual([]);
  });

  test('a light probe bake that fails after the scene is gone logs nothing', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail: (e: unknown) => void = () => undefined;
    probe.bake = () => new Promise((_, reject) => (fail = reject));
    try {
      const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
        onPick: () => undefined,
        onFocus: () => undefined,
        onWalk: () => undefined,
      });
      scene.dispose();
      fail(new Error('context lost'));
      await new Promise((r) => setTimeout(r, 0));

      expect(warn).not.toHaveBeenCalled();
    } finally {
      probe.bake = () => new Promise(() => undefined);
      warn.mockRestore();
    }
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

  test('walking into a back room starts on the strip in front of the office', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: () => undefined,
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const room = (id: string, z: number) => ({
      id,
      x: 0,
      z,
      width: 8,
      depth: 8,
      background: false,
      pods: [],
      desks: [],
    });
    const inner = scene as unknown as {
      plan: unknown;
      link: { focus: unknown };
      walkX: number;
      walkZ: number;
    };
    inner.plan = {
      rooms: [room('back', -5), room('front', 5)],
      columns: 1,
      narrow: false,
      width: 10,
      depth: 20,
    };
    inner.link.focus = { kind: 'room', id: 'back' };

    scene.toggleWalk();

    expect(inner.walkZ).toBeGreaterThan(10);
    expect(inner.walkX).toBe(0);
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

  test('at eye level a label shows within 12 m and hides past it', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: () => undefined,
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const inner = scene as unknown as {
      camera: { position: Vector3 };
      deskList: unknown[];
      screened: (at: Vector3, own: Box3 | null) => boolean;
    };
    inner.deskList = [];
    inner.camera.position.set(0, 0, 0);

    expect(inner.screened(new Vector3(0, 0, -11.9), null)).toBe(false);
    expect(inner.screened(new Vector3(0, 0, -12.5), null)).toBe(true);
  });

  test('entering walk mode keeps the office plan', async () => {
    const { OfficeScene } = await import('../src/office3d/scene.js');
    const scene = new OfficeScene(fakeElement() as unknown as HTMLElement, {
      onPick: () => undefined,
      onFocus: () => undefined,
      onWalk: () => undefined,
    });
    const desk = (agentId: number): DeskModel => ({
      agentId,
      name: `a${agentId}`,
      label: `a${agentId}`,
      pane: null,
      status: 'idle',
      tool: null,
      contextRatio: 0,
      helpers: [],
    });
    const room = (id: string, agentId: number) => ({
      id,
      title: id,
      pods: [{ id, title: id, pinned: false, hasOverseer: true, desks: [desk(agentId)] }],
    });
    const snapshot = { rooms: [room('a', 1), room('b', 2)], selectedId: null };
    const inner = scene as unknown as { plan: unknown };
    scene.update(snapshot);
    const overview = JSON.stringify(inner.plan);

    scene.toggleWalk();
    scene.update(snapshot);

    expect(JSON.stringify(inner.plan)).toBe(overview);
  });
});
