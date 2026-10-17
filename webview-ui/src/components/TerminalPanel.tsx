import '@xterm/xterm/css/xterm.css';

import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import {
  TERMINAL_BG,
  TERMINAL_CURSOR,
  TERMINAL_FG,
  TERMINAL_FONT_PX,
  TERMINAL_QUEUED_INPUT_MAX_BYTES,
} from '../constants.js';

const terminalFontFamily = 'ui-monospace, monospace';

export interface TerminalPanelLocation {
  session: string;
  windowId: string;
  paneId: string;
}

export interface TerminalPanelProps {
  agentId: number;
  name: string | null;
  tmux: TerminalPanelLocation;
  /** Server snapshots so far; each one reopens the terminal socket. */
  reconnects: number;
  onClose: () => void;
}

function terminalSocketUrl(agentId: number, cols: number, rows: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  params.set('agentId', String(agentId));
  params.set('cols', String(cols));
  params.set('rows', String(rows));
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) params.set('token', token);
  return `${protocol}//${window.location.host}/ws/term?${params.toString()}`;
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Resize the terminal to as many whole cells as fit in its host at the current font. */
function fitTerminal(term: Terminal, host: HTMLElement): void {
  const screen = host.querySelector('.xterm-screen');
  if (!(screen instanceof HTMLElement)) return;
  const cellWidth = screen.offsetWidth / term.cols;
  const cellHeight = screen.offsetHeight / term.rows;
  if (!(cellWidth > 0) || !(cellHeight > 0)) return;
  const cols = Math.max(1, Math.floor(host.clientWidth / cellWidth));
  const rows = Math.max(1, Math.floor(host.clientHeight / cellHeight));
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
}

/**
 * Browser terminal for one agent's tmux pane. The panel picks the cols and rows
 * that fit at a fixed font, and the tmux window takes that size while this
 * browser is the client used last.
 */
export function TerminalPanel({ agentId, name, tmux, reconnects, onClose }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Next to the office the panel gets 45% of the page; wide gives it all of it.
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setDisconnected(false);
    setError(null);
    const term = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: TERMINAL_FONT_PX,
      scrollback: 0,
      cursorBlink: false,
      theme: {
        background: cssColor('--color-bg', TERMINAL_BG),
        foreground: cssColor('--color-text', TERMINAL_FG),
        cursor: cssColor('--color-accent-bright', TERMINAL_CURSOR),
      },
    });
    term.open(host);
    fitTerminal(term, host);

    const socket = new WebSocket(terminalSocketUrl(agentId, term.cols, term.rows));
    socket.binaryType = 'arraybuffer';
    socket.onclose = () => setDisconnected(true);
    socket.onerror = () => setDisconnected(true);
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let message: { type?: string; message?: string };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          return;
        }
        if (message.type === 'error') {
          setError(message.message ?? 'could not attach');
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      // Raw bytes: xterm keeps UTF-8 decoder state across frames.
      term.write(new Uint8Array(event.data));
    };
    const sendSize = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const resized = term.onResize(sendSize);
    const encoder = new TextEncoder();
    const queued: Uint8Array[] = [];
    let queuedBytes = 0;
    let overflowed = false;
    socket.onopen = () => {
      sendSize();
      for (const bytes of queued) socket.send(bytes);
      queued.length = 0;
    };
    const input = term.onData((data) => {
      const bytes = encoder.encode(data);
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
      else if (socket.readyState === WebSocket.CONNECTING && !overflowed) {
        if (queuedBytes + bytes.length > TERMINAL_QUEUED_INPUT_MAX_BYTES) {
          overflowed = true;
          queued.length = 0;
        } else {
          queued.push(bytes);
          queuedBytes += bytes.length;
        }
      }
    });

    const observer = new ResizeObserver(() => fitTerminal(term, host));
    observer.observe(host);
    return () => {
      observer.disconnect();
      resized.dispose();
      input.dispose();
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      term.dispose();
    };
  }, [agentId, tmux.session, tmux.windowId, tmux.paneId, reconnects]);

  const target = `${tmux.session}:${tmux.windowId}.${tmux.paneId}`;
  return (
    // Keys typed into the pane must not reach the office's window-level shortcuts.
    <aside
      className={wide ? 'terminal-panel terminal-panel-wide' : 'terminal-panel'}
      aria-label="Terminal"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="terminal-panel-header">
        <p className="terminal-panel-title">
          <span>{target}</span>
          {name ? <span className="terminal-panel-name">{name}</span> : null}
          {disconnected ? <span className="terminal-panel-name">disconnected</span> : null}
          {error ? <span className="terminal-panel-name">{error}</span> : null}
        </p>
        <span className="terminal-panel-actions">
          <button
            type="button"
            className="terminal-panel-close"
            aria-label={wide ? 'Show the office next to the terminal' : 'Widen the terminal'}
            aria-pressed={wide}
            onClick={() => setWide((value) => !value)}
          >
            {wide ? 'split' : 'wide'}
          </button>
          <button
            type="button"
            className="terminal-panel-close"
            aria-label="Close terminal"
            onClick={onClose}
          >
            ×
          </button>
        </span>
      </header>
      <div ref={hostRef} className="terminal-panel-body" />
    </aside>
  );
}
