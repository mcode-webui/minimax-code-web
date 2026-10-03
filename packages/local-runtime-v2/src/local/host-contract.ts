import type { RunawayGuardOverride } from '@mavis/config';
import type {
  CreateLocalRuntimeHostOptions as V1CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost as V1CreatedLocalRuntimeHost,
  LocalRuntimeProductHostOptions as V1LocalRuntimeProductHostOptions,
} from '@mavis/local-runtime';
import type { LocalBrowserAdapter, LocalBrowserToolExposure } from '@mavis/agent-tools/desktop';
import type { RuntimeApplications } from '../application/initialize.js';
import type { RuntimeServices } from '../services.js';
import type {
  MiniAppPresenter,
  LocalRuntimeApplication,
  LocalRuntimePendingPermission,
} from '../application/session/process-local-application-contract.js';

export type { LocalRuntimeAuthContext, LocalRuntimeConfig } from '@mavis/local-runtime';

/** Process-local DTO; runtime.ts checks compatibility with the DB-owned observation. */
type DatabaseMigrationObservation = {
  readonly startedAtEpochMs: number;
  readonly pendingMigrationCount: number;
} & (
  | { readonly phase: 'started' }
  | { readonly phase: 'completed' | 'failed'; readonly durationMs: number }
);

/** Process-local DTO for durable ToolResult compaction thresholds. */
interface ToolResultCompactionConfig {
  readonly enabled?: boolean;
  /** Per-result pre-History safety fuse. Independent from enabled. */
  readonly maxInlineBytes?: number;
  /** Raw MCP detail fuse applied after Plugin hooks and before History. */
  readonly mcpDetailsMaxInlineBytes?: number;
  readonly watermarkBytes?: number;
  readonly minSavingsBytes?: number;
  readonly minCandidateBytes?: number;
  readonly keepRecentRounds?: number;
}

/** Product-facing options owned by the Runtime V2 process-local host. */
interface LocalRuntimeProductHostOptions extends V1LocalRuntimeProductHostOptions {
  /** Best-effort DB upgrade observations; never awaited by startup. */
  onDatabaseMigration?: (event: DatabaseMigrationObservation) => undefined;
  configSource?: 'default' | 'explicit';
  miniAppSurface?: MiniAppPresenter;
  /** Raw product provider consumed directly by the V2 Browser Use owner. */
  browserAdapter?: LocalBrowserAdapter;
  browserToolExposure?: LocalBrowserToolExposure;
  /** Optional live config source; missing/invalid fields retain runtime defaults. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
  promptConfigKey?: Uint8Array;
  /** Selects a complete package-local mode template and freezes prompt assets for this process. */
  promptMode?: 'tui' | 'coding' | 'work';
}

/** Runtime V2 host options after process-local compatibility wiring. */
interface CreateLocalRuntimeHostOptions extends V1CreateLocalRuntimeHostOptions {
  /** Best-effort DB upgrade observations; never awaited by startup. */
  onDatabaseMigration?: (event: DatabaseMigrationObservation) => undefined;
  configSource?: 'default' | 'explicit';
  miniAppSurface?: MiniAppPresenter;
  browserAdapter?: LocalBrowserAdapter;
  browserToolExposure?: LocalBrowserToolExposure;
  /** Optional live config source; missing/invalid fields retain runtime defaults. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
  promptConfigKey?: Uint8Array;
  /** Selects a complete package-local mode template and freezes prompt assets for this process. */
  promptMode?: 'tui' | 'coding' | 'work';
}

/** Runtime V2 owner host with its process-local application facade. */
interface CreatedLocalRuntimeHost extends V1CreatedLocalRuntimeHost {
  application?: LocalRuntimeApplication;
  /**
   * Feature applications (session.query/content/lifecycle/root/diff,
   * queue). Distinct from `application`: the process-local product facade
   * has no turn-diff use case, so an embedder that needs turn diff
   * reads it from `applications.session.diff` here.
   */
  applications?: RuntimeApplications;
  cliService?: import('./cli-service.js').CliService;
  /**
   * The composed V2 service owners (`managedWorktrees`, `pinService`,
   * `agent`, `mcp`, `skill`, `modelSystem`, …), handed to the embedder
   * as-is. Distinct from `application` / `applications`: those two are
   * the PRODUCT use cases, this is the OWNER graph behind them, so a
   * consumer that finds no use case it can call (`agent` has none on
   * the process-local facade) still has a real path to the capability.
   *
   * Optional because a host without the V2 compatibility slice
   * (`compatibility === undefined`) has no service owners at all — the
   * member is absent rather than an empty object, so "no owner" and
   * "owner with no members" cannot be confused. Every member is
   * `readonly`; lifecycle stays with the host's `close()`.
   */
  services?: RuntimeServices;
}

export type {
  CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost,
  LocalRuntimeApplication,
  LocalRuntimePendingPermission,
  LocalRuntimeProductHostOptions,
  ToolResultCompactionConfig,
};
