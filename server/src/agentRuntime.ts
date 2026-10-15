/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { OfficeRooms } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CLAUDE_SESSION_POLL_INTERVAL_MS, DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSession,
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { mayCreateDiscoveredTopLevel } from './liveOnly.js';
import { syncLiveSessionMetadata } from './liveSessionSync.js';
import { resolveLiveTmuxLocations } from './liveTmuxLocation.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import {
  type ClaudeSessionRegistry,
  type LiveClaudeSession,
  transcriptPathForSession,
} from './providers/hook/claude/claudeSessionRegistry.js';
import { SessionRouter } from './sessionRouter.js';
import { SubagentWatch } from './subagentWatch.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { listTmuxPanes, type TmuxPaneRecord } from './tmuxTerminal.js';
import {
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setTeamSwitchCallback,
} from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private liveSessionTimer: ReturnType<typeof setInterval> | null = null;
  private lastLiveSessionCount = -1;
  /**
   * Latest `tmux list-panes` snapshot. Null means the list failed or has not
   * returned, so this tick keeps the registry's own tmux fields.
   */
  private paneIndex: readonly TmuxPaneRecord[] | null = null;
  /** Bumped on each list and on dispose, so a stale result cannot apply. */
  private livePaneGeneration = 0;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  /**
   * Process-lifetime latch for the CLI `--watch-all` flag. webviewReady and
   * the settings checkbox read the persisted preference and would otherwise
   * turn Watch All Sessions back off. Not written to disk.
   */
  forceWatchAll = false;
  /**
   * CLI `--live-only`. Top-level agents exist only while their session id is
   * in the Claude session registry. Not written to disk.
   */
  readonly liveOnly = { current: false };
  /** Named rooms from PIXEL_AGENTS_OFFICE_ROOMS, replayed on webviewReady. */
  officeRooms: OfficeRooms | null = null;
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  readonly subagentWatch: SubagentWatch;
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    provider: HookProvider,
  ) {
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    this.subagentWatch = new SubagentWatch(store);
    setSubagentWatch(this.subagentWatch);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      this.subagentWatch.removeBySpawn(leadId, toolUseId);
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        if (!mayCreateDiscoveredTopLevel(this.liveOnly.current)) {
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        // Covers real team leads AND leads of background teammates (which
        // have children but no teamName). No-op when childless.
        this.removeTeammates(agentId);
        // Unnamed background spawns die with their lead's session too.
        this.subagentWatch.removeByLead(agentId);
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
      this.liveOnly,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;
    // Its only job is adopting top-level transcripts. Live-only adopts those
    // from the registry tick instead.
    if (!mayCreateDiscoveredTopLevel(this.liveOnly.current)) {
      return;
    }

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /**
   * Poll the Claude session registry. The first tick runs immediately.
   * Adopts a live session when Watch All is on, its project dir is tracked,
   * or `--live-only` is set (every live session). A session that leaves the
   * registry drops its agent only in live-only mode.
   * Each tick also lists tmux panes once and follows them by pane id.
   */
  startLiveSessionRegistry(
    registry: ClaudeSessionRegistry,
    listPanes: () => Promise<readonly TmuxPaneRecord[] | null> = listTmuxPanes,
  ): void {
    if (this.liveSessionTimer) return;
    const tick = (): void => {
      try {
        registry.refresh();
        this.applyLiveSessions(registry);
      } catch (err) {
        console.error(
          `[Pixel Agents] Live session scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.refreshLivePaneIndex(registry, listPanes);
    };
    tick();
    this.liveSessionTimer = setInterval(tick, CLAUDE_SESSION_POLL_INTERVAL_MS);
  }

  /**
   * One read-only pane list per tick. The result is applied when it arrives.
   * A newer tick or dispose wins, and a failure keeps the registry locations.
   * Refresh again here: the in-memory registry may be older than the files,
   * and removal must not run against that stale set.
   */
  private refreshLivePaneIndex(
    registry: ClaudeSessionRegistry,
    listPanes: () => Promise<readonly TmuxPaneRecord[] | null>,
  ): void {
    const generation = ++this.livePaneGeneration;
    void listPanes()
      .then((panes) => {
        this.applyPaneIndex(registry, generation, panes);
      })
      .catch(() => {
        this.applyPaneIndex(registry, generation, null);
      });
  }

  private applyPaneIndex(
    registry: ClaudeSessionRegistry,
    generation: number,
    panes: readonly TmuxPaneRecord[] | null,
  ): void {
    if (generation !== this.livePaneGeneration) {
      return;
    }
    this.paneIndex = panes;
    try {
      registry.refresh();
      this.applyLiveSessions(registry);
    } catch (err) {
      console.error(
        `[Pixel Agents] Live session scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private applyLiveSessions(registry: ClaudeSessionRegistry): void {
    const sessions = registry.sessions();
    if (sessions.length !== this.lastLiveSessionCount) {
      this.lastLiveSessionCount = sessions.length;
      console.log(`[Pixel Agents] Live Claude sessions: ${sessions.length}`);
    }
    // Copies only. Registry objects stay as read from disk, so a later failed
    // listing can fall back to those tmux fields.
    const locations = resolveLiveTmuxLocations(sessions, this.paneIndex);
    const corrected = sessions.map((session) => ({
      ...session,
      tmux: locations.get(session.sessionId) ?? null,
    }));
    const byId = new Map(corrected.map((session) => [session.sessionId, session]));
    syncLiveSessionMetadata(this.store, { get: (sessionId) => byId.get(sessionId) });
    for (const session of corrected) {
      this.adoptLiveSession(session);
    }
    this.removeSessionsThatLeft(registry);
  }

  /**
   * Drop top-level agents whose session is no longer in the registry.
   * Children stay while their lead stays, and leave with the lead.
   * The transcript is not dismissed: a new pid with the same session id
   * must be adopted on a later tick.
   */
  private removeSessionsThatLeft(registry: ClaudeSessionRegistry): void {
    if (!this.liveOnly.current) return;
    const live = new Set(registry.sessions().map((session) => session.sessionId));
    const departing: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId !== undefined) continue;
      if (live.has(agent.sessionId)) continue;
      departing.push(id);
    }
    for (const id of departing) {
      this.removeTeammates(id);
      this.subagentWatch.removeByLead(id);
      const agent = this.store.get(id);
      if (!agent) continue;
      this.unregisterAgent(agent.sessionId);
      this.removeAgent(id);
    }
  }

  private adoptLiveSession(session: LiveClaudeSession): void {
    const jsonlFile = transcriptPathForSession(session);
    if (!jsonlFile) return;
    const projectDir = path.dirname(jsonlFile);
    const watching =
      this.liveOnly.current ||
      this.forceWatchAll ||
      this.watchAllSessions.current ||
      isTrackedProjectDir(projectDir);
    if (!watching) return;
    for (const agent of this.store.values()) {
      if (agent.sessionId === session.sessionId || pathsMatch(agent.jsonlFile, jsonlFile)) return;
    }
    if (this.dismissalTracker.isDismissed(jsonlFile)) return;
    if (this.dismissalTracker.isPermanentlyDismissed(jsonlFile)) return;

    this.knownJsonlFiles.add(jsonlFile);
    this.dismissalTracker.clearSeededMtime(jsonlFile);
    adoptExternalSession(
      jsonlFile,
      projectDir,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
    );
    const adopted = [...this.store.values()].find(
      (agent) => agent.sessionId === session.sessionId || pathsMatch(agent.jsonlFile, jsonlFile),
    );
    if (!adopted) return;
    adopted.sessionId = session.sessionId;
    adopted.tmux = session.tmux;
    adopted.registryName = session.name;
    this.registerAgent(adopted.sessionId, adopted.id);
    this.store.broadcast({
      type: 'agentTerminal',
      id: adopted.id,
      name: session.name,
      tmux: session.tmux,
    });
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    if (!mayCreateDiscoveredTopLevel(this.liveOnly.current)) {
      return;
    }
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches.
        backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        hookDelivered: false,
        contextTokens: 0,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
      };

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.hookEventHandler.dispose();
    this.subagentWatch.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.liveSessionTimer) {
      clearInterval(this.liveSessionTimer);
      this.liveSessionTimer = null;
    }
    this.livePaneGeneration++;

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
