/**
 * Which of the owner's vault names a profile a mandate wrote may read (PRD
 * customer-granted-operator-access §3.13, "Verbundene Konten": the names the owner released to
 * exactly that profile).
 *
 * A mandate puts no value into the vault (`PUT /api/secrets/:name` is the owner's), so every name
 * a profile of a mandate reads, apart from the tokens its own connection wrote, holds a value of
 * the owner's or none. The profile only names it; the owner decides whether the value goes there.
 *
 * - A **request** is what a profile asked for when its mandate saved it. The engine writes it,
 *   for the mandate's save; it grants nothing.
 * - A **release** is the owner's answer. Only {@link SecretReleases.release} writes one, and it
 *   takes the owner's principal and nothing else.
 *
 * A release holds for one profile, one author and one grant (`mandate_id`), and for the
 * `binding` the owner was shown: where the value goes and in which role
 * (`profile-secret-view.ts`, `releaseBinding`). Whether it still applies is decided by the
 * reader at every read, against the profile as it is then; nothing here expires a row. A later
 * mandate for the same address is another grant and finds nothing, as with a connection
 * (`connected_mandate_id`) and a mandate's end (`mandate-ends.ts`).
 */
import type Database from 'better-sqlite3';
import type { RequestPrincipal } from './request-principal.js';

/** The owner's principal: the only one {@link SecretReleases.release} takes. */
export type OwnerPrincipal = Extract<RequestPrincipal, { kind: 'owner' }>;

export interface ReleaseRow {
  readonly profileId: string;
  readonly profileAuthor: string;
  readonly name: string;
  readonly binding: string;
  readonly mandateId: string;
  /** ISO time the request was made or the release given. */
  readonly at: string;
}

/** What a mandate's save asks for: one entry per name, with where its value would go. */
export interface ReleaseAsk {
  readonly name: string;
  readonly binding: string;
}

/** Open requests one grant may hold at once; the names are the mandate's choice. */
export const MAX_REQUESTS_PER_MANDATE = 50;

interface Row {
  profile_id: string;
  profile_author: string;
  name: string;
  binding: string;
  mandate_id: string;
  at: string;
}

function toRow(r: Row): ReleaseRow {
  return { profileId: r.profile_id, profileAuthor: r.profile_author, name: r.name, binding: r.binding, mandateId: r.mandate_id, at: r.at };
}

export class SecretReleases {
  private readonly db: Database.Database;
  private readonly selectRelease: Database.Statement;
  private readonly selectRequest: Database.Statement;
  private readonly insertRequest: Database.Statement;
  private readonly countRequests: Database.Statement;
  private readonly deleteRequestsOfProfile: Database.Statement;
  private readonly deleteRequest: Database.Statement;
  private readonly upsertRelease: Database.Statement;
  private readonly deleteRelease: Database.Statement;
  private readonly deleteReleasesOfProfile: Database.Statement;
  private readonly allRequests: Database.Statement;
  private readonly allReleases: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.selectRelease = db.prepare(
      `SELECT binding, mandate_id FROM secret_releases WHERE profile_id = ? AND profile_author = ? AND name = ?`,
    );
    this.selectRequest = db.prepare(
      `SELECT profile_id, profile_author, name, binding, mandate_id, requested_at AS at
       FROM secret_release_requests WHERE profile_id = ? AND name = ?`,
    );
    this.insertRequest = db.prepare(
      `INSERT OR REPLACE INTO secret_release_requests (profile_id, profile_author, name, binding, mandate_id, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.countRequests = db.prepare('SELECT COUNT(*) AS n FROM secret_release_requests WHERE mandate_id = ?');
    this.deleteRequestsOfProfile = db.prepare('DELETE FROM secret_release_requests WHERE profile_id = ?');
    this.deleteRequest = db.prepare('DELETE FROM secret_release_requests WHERE profile_id = ? AND name = ?');
    this.upsertRelease = db.prepare(
      `INSERT OR REPLACE INTO secret_releases (profile_id, profile_author, name, binding, mandate_id, released_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.deleteRelease = db.prepare('DELETE FROM secret_releases WHERE profile_id = ? AND name = ?');
    this.deleteReleasesOfProfile = db.prepare('DELETE FROM secret_releases WHERE profile_id = ?');
    this.allRequests = db.prepare(
      `SELECT profile_id, profile_author, name, binding, mandate_id, requested_at AS at
       FROM secret_release_requests ORDER BY requested_at, profile_id, name`,
    );
    this.allReleases = db.prepare(
      `SELECT profile_id, profile_author, name, binding, mandate_id, released_at AS at
       FROM secret_releases ORDER BY released_at, profile_id, name`,
    );
  }

  /**
   * The release for this profile, author and name, if the owner gave one. The caller compares
   * its `binding` and `mandateId` with the profile and the grant as they are now.
   */
  releaseOf(profileId: string, profileAuthor: string, name: string): { binding: string; mandateId: string } | undefined {
    const row = this.selectRelease.get(profileId, profileAuthor, name) as { binding: string; mandate_id: string } | undefined;
    return row === undefined ? undefined : { binding: row.binding, mandateId: row.mandate_id };
  }

  /** The open request for this profile and name, if one is. */
  requestOf(profileId: string, name: string): ReleaseRow | undefined {
    const row = this.selectRequest.get(profileId, name) as Row | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  /**
   * Replace what `profileId` asks for with `asks`, for the save of the mandate `mandateId`. A name
   * the profile no longer reads leaves no request behind. Requests past
   * {@link MAX_REQUESTS_PER_MANDATE} for that grant are not written; returns how many were.
   */
  replaceRequests(profileId: string, profileAuthor: string, mandateId: string, asks: readonly ReleaseAsk[]): number {
    const now = new Date().toISOString();
    let written = 0;
    this.db.transaction(() => {
      this.deleteRequestsOfProfile.run(profileId);
      for (const ask of asks) {
        const held = (this.countRequests.get(mandateId) as { n: number }).n;
        if (held >= MAX_REQUESTS_PER_MANDATE) break;
        this.insertRequest.run(profileId, profileAuthor, ask.name, ask.binding, mandateId, now);
        written++;
      }
    })();
    return written;
  }

  /**
   * The owner releases `name` to the profile `profileId` of `profileAuthor`, for the grant
   * `mandateId` and the `binding` the owner was shown. Any open request for it is answered.
   */
  release(_owner: OwnerPrincipal, row: { profileId: string; profileAuthor: string; name: string; binding: string; mandateId: string }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.upsertRelease.run(row.profileId, row.profileAuthor, row.name, row.binding, row.mandateId, now);
      this.deleteRequest.run(row.profileId, row.name);
    })();
  }

  /** The owner takes a release back. True when there was one. */
  withdraw(_owner: OwnerPrincipal, profileId: string, name: string): boolean {
    return this.deleteRelease.run(profileId, name).changes > 0;
  }

  /** Forget everything about `profileId`: it was deleted, or it is the owner's now. */
  forgetProfile(profileId: string): void {
    this.db.transaction(() => {
      this.deleteRequestsOfProfile.run(profileId);
      this.deleteReleasesOfProfile.run(profileId);
    })();
  }

  /** Every open request, oldest first. For the owner's view; never for a mandate's. */
  pendingReleases(): ReleaseRow[] {
    return (this.allRequests.all() as Row[]).map(toRow);
  }

  /** Every release the owner gave, oldest first. Whether each still applies is the reader's call. */
  activeReleases(): ReleaseRow[] {
    return (this.allReleases.all() as Row[]).map(toRow);
  }
}
