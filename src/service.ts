import { ApiError } from "./core/errors";
import {
  buildGrid,
  Characteristics,
  computeCharacteristics,
  computePoint,
  PointResult,
  summarizeSweep,
  SweepSpec,
  SweepSummary,
  validateCircuitParams,
  validateFrequency,
  LIMITS,
} from "./core/rlc";
import * as db from "./db";

export function parseCircuitBody(body: Record<string, unknown>) {
  const p = {
    r: Number(body.r),
    l: Number(body.l),
    c: Number(body.c),
    v: body.v === undefined ? NaN : Number(body.v),
  };
  validateCircuitParams(p);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "unnamed";
  if (name.length > LIMITS.NAME_MAX) throw new ApiError("OUT_OF_RANGE", "名称过长");
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : undefined;
  return { p, name, clientRequestId };
}

export function createCircuit(body: Record<string, unknown>) {
  const { p, name, clientRequestId } = parseCircuitBody(body);
  const { row, idempotent } = db.saveCircuit(name, p, clientRequestId);
  return { circuit: row, idempotent };
}

export function mustGetCircuit(id: number): db.CircuitRow {
  const row = db.getCircuit(id);
  if (!row) throw new ApiError("NOT_FOUND", `电路 ${id} 不存在`);
  return row;
}

export function singlePoint(circuitId: number, f: number, clientRequestId?: string) {
  const row = mustGetCircuit(circuitId);
  validateFrequency(f);
  const point = computePoint(db.circuitParams(row), f);
  const { report, idempotent } = db.saveReport(
    circuitId,
    "point",
    { mode: "point", frequencyHz: f },
    [point],
    null,
    clientRequestId
  );
  return { report, point, idempotent };
}

export function runSweep(circuitId: number, spec: SweepSpec, clientRequestId?: string) {
  const row = mustGetCircuit(circuitId);
  const params = db.circuitParams(row);
  const freqs = buildGrid(spec);
  const points = freqs.map((f) => computePoint(params, f));
  const summary = summarizeSweep(params, freqs, points);
  const { report, idempotent } = db.saveReport(circuitId, "sweep", spec, points, summary, clientRequestId);
  return { report, points, summary, idempotent };
}

export function getReportView(reportId: number) {
  const report = db.getReport(reportId);
  if (!report) throw new ApiError("NOT_FOUND", `报告 ${reportId} 不存在`);
  const points = db.getPoints(reportId);
  return {
    report,
    points,
    summary: report.summary ? (JSON.parse(report.summary) as SweepSummary) : null,
  };
}

export function getCharacteristics(circuitId: number): Characteristics {
  const row = mustGetCircuit(circuitId);
  return computeCharacteristics(db.circuitParams(row));
}

export function compareCircuits(idA: number, idB: number) {
  const a = mustGetCircuit(idA);
  const b = mustGetCircuit(idB);
  const ca = computeCharacteristics(db.circuitParams(a));
  const cb = computeCharacteristics(db.circuitParams(b));
  const diffParams: Record<string, { a: number; b: number }> = {};
  for (const k of ["r", "l", "c", "v"] as const) {
    if (a[k] !== b[k]) diffParams[k] = { a: a[k], b: b[k] };
  }
  const diffChar: Record<string, { a: number; b: number }> = {};
  for (const k of Object.keys(ca) as (keyof Characteristics)[]) {
    if (ca[k] !== cb[k]) diffChar[k] = { a: ca[k], b: cb[k] };
  }
  return { a, b, characteristicsA: ca, characteristicsB: cb, diffParams, diffChar };
}

export function reportToCsv(points: PointResult[]): string {
  const header =
    "f_hz,z_re,z_im,z_mag,z_phase_deg,i_re,i_im,i_mag,i_phase_deg,vr_re,vr_im,vl_re,vl_im,vc_re,vc_im,p_active_w,q_reactive_var,s_apparent_va";
  const lines = points.map((p) =>
    [
      p.frequencyHz,
      p.z.re, p.z.im, p.z.mag, p.z.phaseDeg ?? "",
      p.current.re, p.current.im, p.current.mag, p.current.phaseDeg ?? "",
      p.vr.re, p.vr.im, p.vl.re, p.vl.im, p.vc.re, p.vc.im,
      p.pActiveW, p.qReactiveVar, p.sApparentVA,
    ].join(",")
  );
  return [header, ...lines].join("\n");
}
