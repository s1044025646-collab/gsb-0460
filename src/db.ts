import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  ALGO_VERSION,
  CircuitParams,
  PointResult,
  SweepSpec,
  SweepSummary,
} from "./core/rlc";

export const DATA_DIR = process.env.RLC_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "rlc.sqlite");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS circuits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      r REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
      units TEXT NOT NULL,
      algo_version TEXT NOT NULL,
      client_request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circuit_id INTEGER NOT NULL REFERENCES circuits(id),
      kind TEXT NOT NULL,              -- 'point' | 'sweep'
      spec TEXT NOT NULL,              -- SweepSpec 或单点频率 JSON
      summary TEXT,                    -- SweepSummary JSON（扫频）
      algo_version TEXT NOT NULL,
      client_request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS points (
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      payload TEXT NOT NULL,           -- PointResult JSON
      PRIMARY KEY (report_id, idx)
    );
  `);
  return db;
}

export const UNITS = { r: "ohm", l: "henry", c: "farad", v: "volt_rms", f: "hertz" } as const;

export interface CircuitRow {
  id: number;
  name: string;
  r: number;
  l: number;
  c: number;
  v: number;
  units: string;
  algo_version: string;
  client_request_id: string | null;
  created_at: string;
}

export function circuitParams(row: CircuitRow): CircuitParams {
  return { r: row.r, l: row.l, c: row.c, v: row.v };
}

/** 幂等保存电路：相同 clientRequestId 直接返回已有记录 */
export function saveCircuit(name: string, p: CircuitParams, clientRequestId?: string): { row: CircuitRow; idempotent: boolean } {
  const d = getDb();
  if (clientRequestId) {
    const existing = d.prepare("SELECT * FROM circuits WHERE client_request_id = ?").get(clientRequestId) as CircuitRow | undefined;
    if (existing) return { row: existing, idempotent: true };
  }
  const info = d
    .prepare("INSERT INTO circuits (name, r, l, c, v, units, algo_version, client_request_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(name, p.r, p.l, p.c, p.v, JSON.stringify(UNITS), ALGO_VERSION, clientRequestId ?? null);
  const row = d.prepare("SELECT * FROM circuits WHERE id = ?").get(info.lastInsertRowid) as CircuitRow;
  return { row, idempotent: false };
}

export function getCircuit(id: number): CircuitRow | undefined {
  return getDb().prepare("SELECT * FROM circuits WHERE id = ?").get(id) as CircuitRow | undefined;
}

export function listCircuits(): CircuitRow[] {
  return getDb().prepare("SELECT * FROM circuits ORDER BY id").all() as CircuitRow[];
}

export interface ReportRow {
  id: number;
  circuit_id: number;
  kind: string;
  spec: string;
  summary: string | null;
  algo_version: string;
  client_request_id: string | null;
  created_at: string;
}

/**
 * 原子保存报告：任一写入失败整体回滚，不留下貌似完整的曲线。
 * 相同 clientRequestId 幂等返回已有报告。
 */
export function saveReport(
  circuitId: number,
  kind: "point" | "sweep",
  spec: SweepSpec | { mode: "point"; frequencyHz: number },
  points: PointResult[],
  summary: SweepSummary | null,
  clientRequestId?: string
): { report: ReportRow; idempotent: boolean } {
  const d = getDb();
  if (clientRequestId) {
    const existing = d.prepare("SELECT * FROM reports WHERE client_request_id = ?").get(clientRequestId) as ReportRow | undefined;
    if (existing) return { report: existing, idempotent: true };
  }
  const tx = d.transaction(() => {
    const info = d
      .prepare("INSERT INTO reports (circuit_id, kind, spec, summary, algo_version, client_request_id) VALUES (?,?,?,?,?,?)")
      .run(circuitId, kind, JSON.stringify(spec), summary ? JSON.stringify(summary) : null, ALGO_VERSION, clientRequestId ?? null);
    const reportId = Number(info.lastInsertRowid);
    const ins = d.prepare("INSERT INTO points (report_id, idx, payload) VALUES (?,?,?)");
    points.forEach((pt, idx) => ins.run(reportId, idx, JSON.stringify(pt)));
    return reportId;
  });
  const reportId = tx();
  const report = d.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as ReportRow;
  return { report, idempotent: false };
}

export function getReport(id: number): ReportRow | undefined {
  return getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
}

export function listReports(circuitId?: number): ReportRow[] {
  const d = getDb();
  if (circuitId !== undefined) {
    return d.prepare("SELECT * FROM reports WHERE circuit_id = ? ORDER BY id").all(circuitId) as ReportRow[];
  }
  return d.prepare("SELECT * FROM reports ORDER BY id").all() as ReportRow[];
}

export function getPoints(reportId: number): PointResult[] {
  const rows = getDb()
    .prepare("SELECT payload FROM points WHERE report_id = ? ORDER BY idx")
    .all(reportId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as PointResult);
}

export function closeDb(): void {
  db?.close();
  db = null;
}
