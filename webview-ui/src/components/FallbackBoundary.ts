import { Component, type ReactNode } from 'react';

interface FallbackBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/** Renders `fallback` once a child throws, for example a lazy chunk that failed to load. */
export class FallbackBoundary extends Component<FallbackBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
