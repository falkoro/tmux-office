import { describe, expect, it } from 'vitest';

import { FallbackBoundary } from '../src/components/FallbackBoundary.js';

describe('FallbackBoundary', () => {
  it('renders the fallback once a child failed to load', () => {
    const boundary = new FallbackBoundary({ fallback: 'pixel', children: '3d' });
    expect(boundary.render()).toBe('3d');
    boundary.state = { ...boundary.state, ...FallbackBoundary.getDerivedStateFromError() };
    expect(boundary.render()).toBe('pixel');
  });
});
