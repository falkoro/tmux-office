import { describe, expect, it } from 'vitest';

import { FallbackBoundary } from '../src/components/FallbackBoundary.js';

describe('FallbackBoundary', () => {
  it('reports a failed child so the app can leave the 3D view', () => {
    let failures = 0;
    const boundary = new FallbackBoundary({ onError: () => (failures += 1), children: '3d' });
    expect(boundary.render()).toBe('3d');
    boundary.state = { ...boundary.state, ...FallbackBoundary.getDerivedStateFromError() };
    boundary.componentDidCatch();
    expect(failures).toBe(1);
    expect(boundary.render()).toBeNull();
  });
});
