import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALGO_VERSION, CircuitParams, PointResult, UNITS, characteristics, computePoint, validateParams } from "./rlc";
import { SweepRequest, buildGrid, sampledPeak } from "./grid";
import { notFound, validationError } from "./errors";

export interface CircuitVersionRow {
  id: number;
  circuitId: number;
  version: number;
  params: CircuitParams;
  units: typeof UNITS;
  algoVersion: string;
  createdAt: string;
}

export class RlcDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS circuits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS circuit_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circuit_id INTEGER NOT NULL REFERENCES circuits(id),
        version INTEGER NOT NULL,
        r REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
        units TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (circuit_id, version)
      );
      CREATE TABLE IF NOT EXISTS sweeps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circuit_version_id INTEGER NOT NULL REFERENCES circuit_versions(id),
        mode TEXT NOT NULL,
        grid TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sweep_points (
        sweep_id INTEGER NOT NULL REFERENCES sweeps(id),
        idx INTEGER NOT NULL,
        freq_hz REAL NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (sweep_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Create a circuit, or add a new frozen parameter version to an existing one. */
  saveCircuit(params: CircuitParams, name?: string, circuitId?: number): CircuitVersionRow {
    validateParams(params);
    const tx = this.db;
    tx.exec("BEGIN IMMEDIATE");
    try {
      let cid = circuitId;
      if (cid === undefined) {
        const r = tx
          .prepare("INSERT INTO circuits (name) VALUES (?)")
          .run(name ?? "");
        cid = Number(r.lastInsertRowid);
      } else {
        const row = tx.prepare("SELECT id FROM circuits WHERE id = ?").get(cid);
        if (!row) throw notFound(`circuit ${cid} not found`);
      }
      const vrow = tx
        .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM circuit_versions WHERE circuit_id = ?")
        .get(cid) as { v: number };
      const version = vrow.v + 1;
      const res = tx
        .prepare(
          "INSERT INTO circuit_versions (circuit_id, version, r, l, c, v, units, algo_version) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(cid, version, params.r, params.l, params.c, params.v, JSON.stringify(UNITS), ALGO_VERSION);
      tx.exec("COMMIT");
      return this.getVersion(Number(res.lastInsertRowid));
    } catch (e) {
      tx.exec("ROLLBACK");
      throw e;
    }
  }

  getVersion(versionId: number): CircuitVersionRow {
    const row = this.db
      .prepare("SELECT * FROM circuit_versions WHERE id = ?")
      .get(versionId) as Record<string, unknown> | undefined;
    if (!row) throw notFound(`circuit version ${versionId} not found`);
    return {
      id: row.id as number,
      circuitId: row.circuit_id as number,
      version: row.version as number,
      params: { r: row.r as number, l: row.l as number, c: row.c as number, v: row.v as number },
      units: JSON.parse(row.units as string),
      algoVersion: row.algo_version as string,
      createdAt: row.created_at as string,
    };
  }

  latestVersion(circuitId: number): CircuitVersionRow {
    const row = this.db
      .prepare("SELECT id FROM circuit_versions WHERE circuit_id = ? ORDER BY version DESC LIMIT 1")
      .get(circuitId) as { id: number } | undefined;
    if (!row) throw notFound(`circuit ${circuitId} not found`);
    return this.getVersion(row.id);
  }

  listVersions(circuitId: number): CircuitVersionRow[] {
    const rows = this.db
      .prepare("SELECT id FROM circuit_versions WHERE circuit_id = ? ORDER BY version")
      .all(circuitId) as unknown as { id: number }[];
    if (rows.length === 0) throw notFound(`circuit ${circuitId} not found`);
    return rows.map((r) => this.getVersion(r.id));
  }

  listCircuits(): unknown[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.created_at,
                (SELECT COUNT(*) FROM circuit_versions cv WHERE cv.circuit_id = c.id) AS versions
         FROM circuits c ORDER BY c.id`,
      )
      .all();
  }

  point(versionId: number, freqHz: number): PointResult {
    const v = this.getVersion(versionId);
    return computePoint(v.params, freqHz);
  }

  /**
   * Submit a sweep. Idempotent via idempotencyKey: a repeated key returns the
   * stored sweep. The whole batch is written in one transaction, so an invalid
   * batch leaves no partial curve behind.
   */
  submitSweep(versionId: number, req: SweepRequest, idempotencyKey?: string): unknown {
    const v = this.getVersion(versionId);
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
        throw validationError("idempotencyKey must be a non-empty string (<= 200 chars)");
      }
      const existing = this.db
        .prepare("SELECT id FROM sweeps WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: number } | undefined;
      if (existing) return { ...(this.getSweep(existing.id) as object), idempotentReplay: true };
    }
    const grid = buildGrid(req); // throws before any write on invalid input
    const points = grid.map((f) => computePoint(v.params, f));
    const currents = points.map((p) => p.current.mag);
    const peak = sampledPeak(grid, currents);
    const ch = characteristics(v.params);
    const summary = {
      analytic: ch,
      sampledPeak: {
        ...peak,
        note: "max |I| on the discrete grid only; not the exact resonance point",
      },
      pointCount: points.length,
      algoVersion: ALGO_VERSION,
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = this.db
        .prepare("INSERT INTO sweeps (circuit_version_id, mode, grid, idempotency_key, summary) VALUES (?,?,?,?,?)")
        .run(versionId, req.mode, JSON.stringify(grid), idempotencyKey ?? null, JSON.stringify(summary));
      const sweepId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO sweep_points (sweep_id, idx, freq_hz, data) VALUES (?,?,?,?)");
      points.forEach((p, idx) => ins.run(sweepId, idx, p.freqHz, JSON.stringify(p)));
      this.db.exec("COMMIT");
      return this.getSweep(sweepId);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSweep(sweepId: number, includePoints = true): unknown {
    const row = this.db.prepare("SELECT * FROM sweeps WHERE id = ?").get(sweepId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw notFound(`sweep ${sweepId} not found`);
    const out: Record<string, unknown> = {
      sweepId: row.id,
      circuitVersionId: row.circuit_version_id,
      mode: row.mode,
      grid: JSON.parse(row.grid as string),
      summary: JSON.parse(row.summary as string),
      createdAt: row.created_at,
    };
    if (includePoints) {
      const pts = this.db
        .prepare("SELECT data FROM sweep_points WHERE sweep_id = ? ORDER BY idx")
        .all(sweepId) as unknown as { data: string }[];
      out.points = pts.map((p) => JSON.parse(p.data));
    }
    return out;
  }

  listSweeps(versionId: number): unknown[] {
    return this.db
      .prepare("SELECT id, mode, created_at FROM sweeps WHERE circuit_version_id = ? ORDER BY id")
      .all(versionId);
  }

  characteristics(versionId: number): unknown {
    const v = this.getVersion(versionId);
    return { circuitVersionId: versionId, params: v.params, ...characteristics(v.params) };
  }

  compareVersions(versionIdA: number, versionIdB: number): unknown {
    const a = this.getVersion(versionIdA);
    const b = this.getVersion(versionIdB);
    const cha = characteristics(a.params);
    const chb = characteristics(b.params);
    const paramDiff: Record<string, { a: number; b: number }> = {};
    for (const k of ["r", "l", "c", "v"] as const) {
      if (a.params[k] !== b.params[k]) paramDiff[k] = { a: a.params[k], b: b.params[k] };
    }
    const charDiff: Record<string, { a: number | null; b: number | null }> = {};
    for (const k of ["f0Hz", "q", "fLowHz", "fHighHz", "bandwidthHz", "resonanceCurrentRms"] as const) {
      if (cha[k] !== chb[k]) charDiff[k] = { a: cha[k], b: chb[k] };
    }
    return {
      a: { versionId: a.id, circuitId: a.circuitId, version: a.version, params: a.params },
      b: { versionId: b.id, circuitId: b.circuitId, version: b.version, params: b.params },
      paramDiff,
      characteristicsDiff: charDiff,
    };
  }
}

export function sweepToCsv(sweep: { points: PointResult[] }): string {
  const header =
    "freq_hz,z_re,z_im,z_mag,z_phase_deg,i_re,i_im,i_mag,i_phase_deg," +
    "vr_re,vr_im,vl_re,vl_im,vc_re,vc_im,p_active_w,q_reactive_var,s_apparent_va";
  const num = (x: number | null): string => (x === null ? "" : String(x));
  const lines = sweep.points.map((p) =>
    [
      p.freqHz,
      p.impedance.re,
      p.impedance.im,
      p.impedance.mag,
      num(p.impedance.phaseDeg),
      p.current.re,
      p.current.im,
      p.current.mag,
      num(p.current.phaseDeg),
      p.voltageResistor.re,
      p.voltageResistor.im,
      p.voltageInductor.re,
      p.voltageInductor.im,
      p.voltageCapacitor.re,
      p.voltageCapacitor.im,
      p.power.activeW,
      p.power.reactiveVar,
      p.power.apparentVA,
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}
