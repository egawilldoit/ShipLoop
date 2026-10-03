/**
 * Project-scoped settings (mvp-spec 3 "Settings", L02-AC2, L02-AC3).
 *
 * One row per project, mutable in place. Three properties are structural here rather than
 * left to the caller's discipline:
 *
 * 1. **A project is required, and this repository never creates one.** `project_id` is a
 *    foreign key, and unlike the connector repository - which inserts a missing project so
 *    that connector configuration can precede a profile - a settings write refuses a project
 *    this store does not hold. Inventing a project row from a settings write would make
 *    "a project exists" answerable from a field that is not project identity, which is the
 *    confusion `routes/projects.ts` was written to end (F02-AC1, F02-AC4).
 * 2. **A missing row is not configured, not a failure.** `read` answers null and `setT3LaunchUrl`
 *    creates the row, so a project that has never been configured reads as an ordinary
 *    "not configured" state instead of raising a storage error (L02-AC3: the handoff packet
 *    is fully usable with no T3).
 * 3. **No credential reaches a column.** The controller validates the value with
 *    `parseT3LaunchUrl` before this is called; the column's CHECK then refuses anything that
 *    is not an absolute `http:`/`https:` URL. A value carrying a username, a password or a
 *    token cannot be written here, so a settings row cannot become the place a secret is
 *    kept (L02-AC2, N02-AC2).
 *
 * The row is mutable rather than versioned because a setting is current state: the owner
 * clears it and types it again, and a version per edit would be a history nobody reads. The
 * durable, versioned configuration of a project is still the profile
 * (`project_profile_versions`) and the connector references (`connectors`); this table
 * holds only what neither of those can.
 */

import { err, ok } from '@shiploop/domain';
import type { DomainError, ProjectId, Result } from '@shiploop/domain';

import type { Database } from '../db.ts';

/** The columns {@link toSettings} reads. One list, so no read can miss a column. */
const COLUMNS = 'project_id, t3_launch_url, updated_at';

/** One project's settings, exactly as they are stored and returned. */
export interface ProjectSettingsRecord {
  readonly projectId: ProjectId;
  /**
   * The external deployment's base URL, or null when none is configured.
   *
   * Null is a normal state, not an absence to be filled in with a default: there is no
   * T3 hostname built into the product (L02-AC1, L02-AC3).
   */
  readonly t3LaunchUrl: string | null;
  readonly updatedAt: string;
}

/** The persistence port the settings controller depends on. */
export interface ProjectSettingsStore {
  /** The project's settings, or null when this store holds no row for it. */
  read(projectId: ProjectId): Result<ProjectSettingsRecord | null>;
  /**
   * Sets or clears the T3 launch URL, creating the row on first write.
   *
   * `null` clears it. Clearing is a write rather than a delete so the instant the owner
   * changed their mind is recorded.
   */
  setT3LaunchUrl(projectId: ProjectId, url: string | null, at: string): Result<ProjectSettingsRecord>;
}

type Row = Record<string, unknown>;

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`column ${column} is missing or not text`);
  return value;
}

function toSettings(row: Row): ProjectSettingsRecord {
  return {
    projectId: requiredText(row, 'project_id') as ProjectId,
    t3LaunchUrl: optionalText(row, 't3_launch_url'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

export class ProjectSettingsRepository implements ProjectSettingsStore {
  private readonly database: Database;
  private readonly cache = new Map<string, ReturnType<Database['prepare']>>();

  constructor(database: Database) {
    this.database = database;
  }

  private statement(sql: string): ReturnType<Database['prepare']> {
    const cached = this.cache.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.database.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  /**
   * Turns an unexpected driver failure into a typed `Unavailable`.
   *
   * The same rule as every repository here: an expected refusal (NotFound) stays
   * distinguishable from storage being broken, because a caller treats them differently.
   */
  private attempt<T>(description: string, body: () => Result<T, DomainError>): Result<T, DomainError> {
    try {
      return body();
    } catch (error) {
      return err({
        code: 'Unavailable',
        reason: `${description} failed: ${error instanceof Error ? error.message : 'unknown storage failure'}`,
      });
    }
  }

  read(projectId: ProjectId): Result<ProjectSettingsRecord | null> {
    return this.attempt('read project settings', () => {
      const row = this.statement(`SELECT ${COLUMNS} FROM project_settings WHERE project_id = ?`).get(projectId);
      return ok(row === undefined ? null : toSettings(row));
    });
  }

  setT3LaunchUrl(projectId: ProjectId, url: string | null, at: string): Result<ProjectSettingsRecord> {
    return this.attempt('save project settings', () => {
      const project = this.statement('SELECT project_id FROM projects WHERE project_id = ?').get(projectId);
      if (project === undefined) {
        return err({ code: 'NotFound', reason: `Project ${projectId} does not exist.` });
      }
      this.statement(
        `INSERT INTO project_settings (project_id, t3_launch_url, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET t3_launch_url = excluded.t3_launch_url, updated_at = excluded.updated_at`,
      ).run(projectId, url, at);
      const saved = this.statement(`SELECT ${COLUMNS} FROM project_settings WHERE project_id = ?`).get(projectId);
      if (saved === undefined) {
        return err({
          code: 'Unavailable',
          reason: 'The project settings were written and could not be read back, so they are not reported as saved.',
        });
      }
      return ok(toSettings(saved));
    });
  }
}
