import fs from 'node:fs';
import path from 'node:path';

import { branchFor } from './git.mjs';
import {
  applyRow,
  buildSnapshot,
  createMetricsState,
  MAX_TOOLS,
  MAX_STEPS,
} from './metrics.mjs';
import { createBucket, readNewRows, TICK_READ_BYTES } from './wire-reader.mjs';

/**
 * Keeps one session's journal readers and metric state in sync with disk.
 * `poll()` is cheap when nothing changed: it only stats the journals.
 */
export class SessionTracker {
  constructor(session, { maxRowsPerTick = 4000 } = {}) {
    this.session = session;
    this.maxRowsPerTick = maxRowsPerTick;
    this.state = createMetricsState();
    this.readers = new Map();
    this.branch = null;
    this.branchFor = null;
    this.error = null;
    this.loadedAt = Date.now();
  }

  get id() {
    return this.session.id;
  }

  syncReaders() {
    const agentsDir = path.join(this.session.dir, 'agents');
    let names = [];
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      return false;
    }
    let added = false;
    for (const name of names) {
      if (this.readers.has(name)) continue;
      const wire = path.join(agentsDir, name, 'wire.jsonl');
      try {
        if (!fs.statSync(wire).isFile()) continue;
      } catch {
        continue;
      }
      this.readers.set(name, { agent: name, bucket: createBucket(wire) });
      added = true;
    }
    return added;
  }

  /** Read new journal bytes and fold them into the metric state. */
  poll({ now = Date.now() } = {}) {
    let changed = false;
    this.syncReaders();

    let budget = this.maxRowsPerTick;
    for (const reader of this.readers.values()) {
      while (budget > 0) {
        let result;
        try {
          result = readNewRows(reader.bucket, { limit: TICK_READ_BYTES });
        } catch (error) {
          this.error = String(error && error.message ? error.message : error);
          break;
        }
        if (!result.changed || result.rows.length === 0) {
          if (result.changed) changed = true;
          break;
        }
        changed = true;
        for (const row of result.rows) applyRow(this.state, row, reader.agent);
        budget -= result.rows.length;
        if (result.rows.length === 0) break;
      }
    }

    if (this.branchFor !== this.session.cwd) {
      this.branchFor = this.session.cwd;
      this.branch = null;
      branchFor(this.session.cwd).then((value) => { this.branch = value; });
    }

    return { changed, snapshot: this.snapshot(now) };
  }

  snapshot(now = Date.now(), server = null) {
    const partial = [...this.readers.values()].some((reader) => reader.bucket.partial);
    return buildSnapshot(this.state, {
      now,
      partial,
      server,
      session: {
        id: this.session.id,
        title: this.session.title,
        cwd: this.session.cwd,
        dir: this.session.dir,
        branch: this.branch,
        archived: this.session.archived,
        agentCount: this.readers.size,
        updatedAt: this.session.updatedAt,
        activityAt: this.session.activityAt,
      },
    });
  }

  /** Rebuild from scratch, e.g. after the journal was rotated. */
  reset() {
    this.state = createMetricsState();
    for (const reader of this.readers.values()) reader.bucket = createBucket(reader.bucket.path);
  }
}

export { MAX_STEPS, MAX_TOOLS };
