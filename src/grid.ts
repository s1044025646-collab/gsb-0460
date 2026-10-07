import { MAX_SWEEP_POINTS, validateFreq } from "./rlc";
import { validationError } from "./errors";

export type SweepMode = "list" | "linear" | "log";

export interface SweepRequest {
  mode: SweepMode;
  freqs?: number[]; // list mode
  start?: number; // linear/log
  end?: number; // linear/log
  count?: number; // linear/log, >= 2
}

/** Build the frequency grid. Endpoints are always included. */
export function buildGrid(req: SweepRequest): number[] {
  if (req.mode === "list") {
    if (!Array.isArray(req.freqs) || req.freqs.length === 0) {
      throw validationError("list mode requires a non-empty freqs array");
    }
    if (req.freqs.length > MAX_SWEEP_POINTS) {
      throw validationError(`too many frequencies (max ${MAX_SWEEP_POINTS})`);
    }
    for (const f of req.freqs) validateFreq(f);
    return req.freqs.slice(); // keep input order
  }
  if (req.mode === "linear" || req.mode === "log") {
    const { start, end, count } = req;
    if (start === undefined || end === undefined || count === undefined) {
      throw validationError(`${req.mode} mode requires start, end and count`);
    }
    validateFreq(start);
    validateFreq(end);
    if (!Number.isInteger(count) || count < 2) {
      throw validationError("count must be an integer >= 2 (endpoints included)");
    }
    if (count > MAX_SWEEP_POINTS) {
      throw validationError(`count too large (max ${MAX_SWEEP_POINTS})`);
    }
    if (end < start) throw validationError("end must be >= start");
    const out: number[] = [];
    if (req.mode === "linear") {
      const step = (end - start) / (count - 1);
      for (let k = 0; k < count; k++) out.push(k === count - 1 ? end : start + step * k);
    } else {
      const ratio = Math.pow(end / start, 1 / (count - 1));
      for (let k = 0; k < count; k++) out.push(k === count - 1 ? end : start * Math.pow(ratio, k));
    }
    return out;
  }
  throw validationError(`unknown sweep mode: ${String(req.mode)}`);
}

/** Peak sample info: max |I| on the discrete grid, with resolution annotation. */
export function sampledPeak(freqs: number[], currents: number[]): { freqHz: number; currentRms: number; resolutionHz: number | null } {
  let best = 0;
  for (let k = 1; k < currents.length; k++) if (currents[k] > currents[best]) best = k;
  let resolutionHz: number | null = null;
  if (freqs.length >= 2) {
    const left = best > 0 ? freqs[best] - freqs[best - 1] : Infinity;
    const right = best < freqs.length - 1 ? freqs[best + 1] - freqs[best] : Infinity;
    const r = Math.min(left, right);
    resolutionHz = Number.isFinite(r) ? r : null;
  }
  return { freqHz: freqs[best], currentRms: currents[best], resolutionHz };
}
