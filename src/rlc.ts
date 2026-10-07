import { Cx, abs, add, cx, div, mul, phaseDeg, scale } from "./complex";
import { rangeError, validationError } from "./errors";

export const ALGO_VERSION = "rlc-1.0.0";

/** Relative/absolute tolerance used for KVL and power-balance verification. */
export const TOL_REL = 1e-9;
export const TOL_ABS = 1e-12;

/** Upper safety limits (this tool does not target arbitrary extreme scales). */
export const MAX_PARAM = 1e12;
export const MIN_PARAM = 1e-12;
export const MAX_FREQ = 1e12;
export const MIN_FREQ = 1e-12;
export const MAX_SWEEP_POINTS = 10000;

export interface CircuitParams {
  r: number; // ohm
  l: number; // henry
  c: number; // farad
  v: number; // V RMS, source phase fixed at 0 degrees
}

export const UNITS = {
  r: "ohm",
  l: "henry",
  c: "farad",
  v: "volt_rms",
  f: "hertz",
  phase: "degree(-180,180]",
} as const;

export interface PhasorOut {
  re: number;
  im: number;
  mag: number;
  phaseDeg: number | null; // null when magnitude is zero
}

export interface PointResult {
  freqHz: number;
  omega: number;
  reactance: { xl: number; xc: number; xTotal: number };
  impedance: PhasorOut;
  current: PhasorOut;
  voltageResistor: PhasorOut;
  voltageInductor: PhasorOut;
  voltageCapacitor: PhasorOut;
  power: {
    activeW: number; // |I|^2 * R
    reactiveVar: number; // |I|^2 * X, sign follows total reactance
    apparentVA: number; // V * |I|
  };
  checks: {
    kvlMaxErr: number; // |VR+VL+VC - V| (phasor sum)
    powerMaxErr: number; // |V*conj(I) - (P + jQ)|
    tolerance: number;
    kvlOk: boolean;
    powerOk: boolean;
  };
}

export interface Characteristics {
  omega0: number;
  f0Hz: number;
  q: number;
  resonanceCurrentRms: number; // V / R
  resonancePowerW: number; // V^2 / R
  omegaLow: number;
  omegaHigh: number;
  fLowHz: number;
  fHighHz: number;
  bandwidthHz: number; // R / (2*pi*L)
  halfPowerCurrentRms: number | null; // null when V = 0 (no measurable power ratio)
  note: string;
}

const assertFinite = (name: string, x: number): void => {
  if (typeof x !== "number" || Number.isNaN(x) || !Number.isFinite(x)) {
    throw rangeError(`non-finite value for ${name}`);
  }
};

export function validateParams(p: CircuitParams): void {
  for (const key of ["r", "l", "c"] as const) {
    const x = p[key];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw validationError(`${key} must be a finite number (got ${String(x)})`);
    }
    if (x <= 0) {
      throw validationError(`${key} must be > 0; R=0/L=0/C=0 is outside the ideal series RLC model`);
    }
    if (x < MIN_PARAM || x > MAX_PARAM) {
      throw validationError(`${key} out of supported range [${MIN_PARAM}, ${MAX_PARAM}]`);
    }
  }
  if (typeof p.v !== "number" || !Number.isFinite(p.v)) {
    throw validationError("v must be a finite number (RMS volts; zero allowed)");
  }
  if (p.v < 0) throw validationError("v (RMS) must be >= 0");
  if (p.v > MAX_PARAM) throw validationError(`v out of supported range [0, ${MAX_PARAM}]`);
}

export function validateFreq(f: number): void {
  if (typeof f !== "number" || !Number.isFinite(f)) {
    throw validationError(`frequency must be a finite number (got ${String(f)})`);
  }
  if (f <= 0) throw validationError("frequency must be > 0 Hz");
  if (f < MIN_FREQ || f > MAX_FREQ) {
    throw validationError(`frequency out of supported range [${MIN_FREQ}, ${MAX_FREQ}] Hz`);
  }
}

const toPhasor = (z: Cx): PhasorOut => ({ re: z.re, im: z.im, mag: abs(z), phaseDeg: phaseDeg(z) });

/** Compute full steady-state AC solution at one frequency. */
export function computePoint(p: CircuitParams, freqHz: number): PointResult {
  validateParams(p);
  validateFreq(freqHz);

  const omega = 2 * Math.PI * freqHz;
  const xl = omega * p.l;
  const xc = -1 / (omega * p.c);
  const xTotal = xl + xc;
  assertFinite("omega", omega);
  assertFinite("xl", xl);
  assertFinite("xc", xc);

  const z: Cx = cx(p.r, xTotal);
  const source: Cx = cx(p.v, 0); // source phase fixed at zero
  const i: Cx = div(source, z);
  assertFinite("current.re", i.re);
  assertFinite("current.im", i.im);

  const vr = scale(i, p.r);
  const vl = mul(i, cx(0, xl));
  const vc = mul(i, cx(0, xc));

  const kvlSum = add(add(vr, vl), vc);
  const kvlErr = Math.hypot(kvlSum.re - source.re, kvlSum.im - source.im);

  const iMag2 = i.re * i.re + i.im * i.im;
  const activeW = iMag2 * p.r;
  const reactiveVar = iMag2 * xTotal;
  const apparentVA = p.v * abs(i);
  assertFinite("activeW", activeW);
  assertFinite("reactiveVar", reactiveVar);

  // Power balance: S = V * conj(I) should equal P + jQ.
  const sRe = p.v * i.re;
  const sIm = -p.v * i.im;
  const powerErr = Math.hypot(sRe - activeW, sIm - reactiveVar);

  const scaleRef = Math.max(abs(source), abs(i) * abs(z), 1);
  const tolerance = TOL_ABS + TOL_REL * scaleRef;

  return {
    freqHz,
    omega,
    reactance: { xl, xc, xTotal },
    impedance: toPhasor(z),
    current: toPhasor(i),
    voltageResistor: toPhasor(vr),
    voltageInductor: toPhasor(vl),
    voltageCapacitor: toPhasor(vc),
    power: { activeW, reactiveVar, apparentVA },
    checks: {
      kvlMaxErr: kvlErr,
      powerMaxErr: powerErr,
      tolerance,
      kvlOk: kvlErr <= tolerance,
      powerOk: powerErr <= tolerance,
    },
  };
}

/** Analytic resonance / half-power characteristics (not from discrete sampling). */
export function characteristics(p: CircuitParams): Characteristics {
  validateParams(p);
  const omega0 = 1 / Math.sqrt(p.l * p.c);
  const f0Hz = omega0 / (2 * Math.PI);
  const q = (omega0 * p.l) / p.r;
  const s = Math.sqrt(p.r * p.r + (4 * p.l) / p.c);
  const omegaLow = 2 / (p.c * (s + p.r));
  const omegaHigh = (s + p.r) / (2 * p.l);
  const fLowHz = omegaLow / (2 * Math.PI);
  const fHighHz = omegaHigh / (2 * Math.PI);
  const bandwidthHz = p.r / (2 * Math.PI * p.l);
  for (const [name, x] of Object.entries({ omega0, f0Hz, q, omegaLow, omegaHigh })) {
    assertFinite(name, x);
  }
  const resonanceCurrentRms = p.v / p.r;
  return {
    omega0,
    f0Hz,
    q,
    resonanceCurrentRms,
    resonancePowerW: (p.v * p.v) / p.r,
    omegaLow,
    omegaHigh,
    fLowHz,
    fHighHz,
    bandwidthHz,
    halfPowerCurrentRms: p.v > 0 ? resonanceCurrentRms / Math.SQRT2 : null,
    note:
      p.v > 0
        ? "analytic values; half-power points are where resistor power equals half of resonance power"
        : "zero source: characteristic frequencies still defined by L,C,R; no measurable power ratio",
  };
}
