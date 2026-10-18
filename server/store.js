// In-memory store with JSON snapshot persistence.
// Shape matches docs/IMPLEMENTATION_PLAN.md Section 2 so a swap to SQLite/Prisma is a storage change, not a model change.
// Append-only tables (events, packets) are never mutated except by append — spec §14 non-negotiable.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// All table names. Order is stable for serialisation.
const TABLES = [
  "calls", "turns", "packets", "incidents", "events",
  "kitShows", "callbacks", "baselines", "zoneWindows", "twists", "costMeter",
];

export class Store {
  /**
   * @param {string|null} path  File path for JSON snapshot, or null for in-memory only.
   */
  constructor(path = null) {
    this.path = path;
    for (const t of TABLES) this[t] = [];
    this._seq = 0;

    if (path && existsSync(path)) {
      try {
        const snap = JSON.parse(readFileSync(path, "utf8"));
        for (const t of TABLES) this[t] = snap[t] || [];
        this._seq = snap._seq || 0;
      } catch {
        // Corrupt snapshot: start clean rather than crashing.
      }
    }
  }

  /** Generate a monotonically increasing id with the given prefix (base-36 counter). */
  nextId(prefix) {
    this._seq += 1;
    return `${prefix}_${this._seq.toString(36)}`;
  }

  /** Flush current state to the snapshot file. No-op when path is null. */
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const snap = { _seq: this._seq };
    for (const t of TABLES) snap[t] = this[t];
    writeFileSync(this.path, JSON.stringify(snap));
  }

  /**
   * Append an event row. Stamps id and ts_server; merges caller-supplied fields.
   * Fires all registered listeners synchronously. Errors in listeners are swallowed.
   * Events are append-only and must never be deleted (spec §14).
   */
  appendEvent(ev) {
    const row = {
      id: this.nextId("ev"),
      ts_server: new Date().toISOString(),
      schema_version: 1,
      ...ev,
    };
    this.events.push(row);
    this.listeners?.forEach((fn) => { try { fn(row); } catch {} });
    return row;
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  onEvent(fn) {
    (this.listeners ||= new Set()).add(fn);
    return () => this.listeners.delete(fn);
  }
}
