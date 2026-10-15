import { Component, type ReactNode } from 'react';

interface FallbackBoundaryProps {
  onError: () => void;
  children: ReactNode;
}

/** Renders nothing once a child throws, for example a lazy chunk that failed to load, and reports it. */
export class FallbackBoundary extends Component<FallbackBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
