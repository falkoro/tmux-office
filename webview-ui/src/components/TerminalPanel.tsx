import '@xterm/xterm/css/xterm.css';

import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import {
  TERMINAL_BG,
  TERMINAL_CURSOR,
  TERMINAL_FG,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
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
  onClose: () => void;
}

function terminalSocketUrl(agentId: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  params.set('agentId', String(agentId));
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) params.set('token', token);
  return `${protocol}//${window.location.host}/ws/term?${params.toString()}`;
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function fitTerminalFont(term: Terminal, host: HTMLElement, cols: number, rows: number): void {
  if (cols < 1 || rows < 1) return;
  const screen = host.querySelector('.xterm-screen');
  if (!(screen instanceof HTMLElement)) return;
  let low = TERMINAL_FONT_MIN_PX;
  let high = TERMINAL_FONT_MAX_PX;
  let best = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    term.options.fontSize = mid;
    const fits = screen.offsetWidth <= host.clientWidth && screen.offsetHeight <= host.clientHeight;
    if (fits) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  term.options.fontSize = best;
}

/**
 * Browser terminal for one agent's tmux pane. The server chooses the cols and
 * rows; the font is scaled so that grid fills this panel.
 */
export function TerminalPanel({ agentId, name, tmux, onClose }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A pane as wide as a desktop terminal is unreadable at 45%; let it take the page.
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: TERMINAL_FONT_MIN_PX,
      scrollback: 0,
      cursorBlink: false,
      theme: {
        background: cssColor('--color-bg', TERMINAL_BG),
        foreground: cssColor('--color-text', TERMINAL_FG),
        cursor: cssColor('--color-accent-bright', TERMINAL_CURSOR),
      },
    });
    term.open(host);

    let cols = 0;
    let rows = 0;
    let sized = false;
    const pending: Uint8Array[] = [];
    const fit = (): void => fitTerminalFont(term, host, cols, rows);

    const socket = new WebSocket(terminalSocketUrl(agentId));
    socket.binaryType = 'arraybuffer';
    socket.onclose = () => setDisconnected(true);
    socket.onerror = () => setDisconnected(true);
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let message: { type?: string; cols?: number; rows?: number; message?: string };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          return;
        }
        if (message.type === 'size' && message.cols && message.rows) {
          cols = message.cols;
          rows = message.rows;
          term.resize(cols, rows);
          sized = true;
          fit();
          for (const chunk of pending) term.write(chunk);
          pending.length = 0;
          return;
        }
        if (message.type === 'error') {
          setError(message.message ?? 'could not attach');
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      // Raw bytes: xterm keeps UTF-8 decoder state across frames.
      const bytes = new Uint8Array(event.data);
      if (!sized) pending.push(bytes);
      else term.write(bytes);
    };
    const encoder = new TextEncoder();
    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [agentId]);

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
