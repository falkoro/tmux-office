import './office3d.css';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { OfficeRooms } from '../../../core/src/messages.js';
import { OFFICE3D_POLL_MS, OFFICE3D_STATUS_COLORS } from '../constants.js';
import type { AgentTerminalMeta } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import type { RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID, deriveOffice, roomHeat } from './model.js';
import { OfficeScene } from './scene.js';

interface Office3DProps {
  officeState: OfficeState;
  agentTerminals: Record<number, AgentTerminalMeta>;
  agentTools: Record<number, ToolActivity[]>;
  officeRooms: OfficeRooms | null;
  onClick: (agentId: number) => void;
}

const STATUS_VARS = Object.fromEntries(
  Object.entries(OFFICE3D_STATUS_COLORS).map(([status, hex]) => [
    `--o3d-${status}`,
    `#${hex.toString(16).padStart(6, '0')}`,
  ]),
) as CSSProperties;

/** The room whose pods the bar lists: the focused room, the focused pod's room, or the only room. */
function barRoom(rooms: RoomModel[], focused: string | null): RoomModel | undefined {
  const grid = rooms.filter((r) => r.id !== BACKGROUND_ROOM_ID);
  return (
    rooms.find((r) => r.id === focused) ??
    rooms.find((r) => r.pods.some((p) => p.id === focused)) ??
    (grid.length === 1 ? grid[0] : undefined)
  );
}

/**
 * The 3D office view. OfficeState is mutated in place by the message handler
 * and never re-renders React, so the scene is fed by a light poll that only
 * pushes a new snapshot when something visible changed.
 */
export default function Office3D(props: Office3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [rooms, setRooms] = useState<RoomModel[]>([]);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new OfficeScene(host, {
      onPick: (id) => {
        // Same toggle the 2D canvas makes before it reports a click.
        const { officeState: os, onClick } = latest.current;
        os.dismissBubble(id);
        // The pixel view finishes a dismissed fade in its game loop, which does
        // not run here. Without this a looked-at desk would stay done forever.
        const ch = os.characters.get(id);
        if (ch?.bubbleType === 'waiting') {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
        const deselect = os.selectedAgentId === id;
        os.selectedAgentId = deselect ? null : id;
        os.cameraFollowId = deselect ? null : id;
        onClick(id);
        poll();
      },
      onFocus: setFocused,
    });
    sceneRef.current = scene;

    let last = '';
    function poll(): void {
      if (document.hidden) return;
      const { officeState: os, agentTerminals, agentTools, officeRooms } = latest.current;
      const next = deriveOffice(os.characters.values(), agentTerminals, agentTools, officeRooms);
      const signature = JSON.stringify([next, os.selectedAgentId]);
      if (signature === last) return;
      last = signature;
      scene.update({ rooms: next, selectedId: os.selectedAgentId });
      setRooms(next);
    }
    poll();
    const timer = window.setInterval(poll, OFFICE3D_POLL_MS);
    return () => {
      window.clearInterval(timer);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const room = barRoom(rooms, focused);
  const pods = room && room.pods.length > 1 ? room.pods : [];
  return (
    <div className="o3d-root" style={STATUS_VARS}>
      <div ref={hostRef} className="o3d-host" />
      <nav className="o3d-bar" aria-label="Rooms">
        <button
          type="button"
          className="o3d-bar-btn"
          aria-pressed={focused === null}
          onClick={() => sceneRef.current?.focus(null)}
        >
          All
        </button>
        {rooms.map((r) => (
          <button
            key={r.id}
            type="button"
            className="o3d-bar-btn"
            aria-pressed={focused === r.id}
            data-heat={roomHeat(r) ?? 'calm'}
            data-pinned={r.pods.some((pod) => pod.pinned) || undefined}
            onClick={() => sceneRef.current?.focus(r.id)}
          >
            {r.title}
          </button>
        ))}
        {pods.length > 0 && <span className="o3d-bar-sep" aria-hidden="true" />}
        {pods.map((pod) => (
          <button
            key={`pod:${pod.id}`}
            type="button"
            className="o3d-bar-btn o3d-bar-pod"
            aria-pressed={focused === pod.id}
            data-heat={roomHeat({ id: pod.id, title: pod.title, pods: [pod] }) ?? 'calm'}
            data-pinned={pod.pinned || undefined}
            onClick={() => sceneRef.current?.focus(pod.id)}
          >
            {pod.title}
          </button>
        ))}
      </nav>
    </div>
  );
}
