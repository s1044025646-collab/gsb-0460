import { ApiError } from "./errors";

export const ALGO_VERSION = "rlc-series-ideal/1.0.0";

/** 数值核验统一容差（相对） */
export const TOL_REL = 1e-9;

/** 参数上限（防止无意义极端尺度） */
export const LIMITS = {
  R_MAX: 1e12,
  L_MAX: 1e6,
  C_MAX: 1e3,
  F_MAX: 1e12,
  V_MAX: 1e9,
  SWEEP_POINTS_MAX: 10000,
  NAME_MAX: 200,
};

export interface Complex {
  re: number;
  im: number;
}

export const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const cmul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const cdiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const cabs = (c: Complex): number => Math.hypot(c.re, c.im);

/**
 * 相位角（度），固定半开区间 (-180, 180]。
 * 模为零时相位未定义，返回 null。
 */
export function phaseDeg(c: Complex): number | null {
  if (cabs(c) === 0) return null;
  let deg = (Math.atan2(c.im, c.re) * 180) / Math.PI;
  // 归一化到 (-180, 180]
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  // 消除 -0
  return deg === 0 ? 0 : deg;
}

export interface Phasor {
  re: number;
  im: number;
  mag: number;
  phaseDeg: number | null;
}

export function toPhasor(c: Complex): Phasor {
  return { re: c.re, im: c.im, mag: cabs(c), phaseDeg: phaseDeg(c) };
}

export interface CircuitParams {
  r: number; // 欧姆
  l: number; // 亨利
  c: number; // 法拉
  v: number; // 电源有效值（伏特 RMS），可为 0
}

function assertFinite(name: string, x: unknown): asserts x is number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new ApiError("INVALID_PARAM", `参数 ${name} 必须是有限数值`, { param: name, value: x });
  }
}

export function validateCircuitParams(p: CircuitParams): void {
  assertFinite("r", p.r);
  assertFinite("l", p.l);
  assertFinite("c", p.c);
  assertFinite("v", p.v);
  if (p.r <= 0) throw new ApiError("INVALID_PARAM", "R 必须为正数（模型不含 R=0）", { param: "r", value: p.r });
  if (p.l <= 0) throw new ApiError("INVALID_PARAM", "L 必须为正数（模型不含 L=0）", { param: "l", value: p.l });
  if (p.c <= 0) throw new ApiError("INVALID_PARAM", "C 必须为正数（模型不含 C=0）", { param: "c", value: p.c });
  if (p.v < 0) throw new ApiError("INVALID_PARAM", "V（有效值）不能为负", { param: "v", value: p.v });
  if (p.r > LIMITS.R_MAX) throw new ApiError("OUT_OF_RANGE", `R 超过上限 ${LIMITS.R_MAX}`, { param: "r" });
  if (p.l > LIMITS.L_MAX) throw new ApiError("OUT_OF_RANGE", `L 超过上限 ${LIMITS.L_MAX}`, { param: "l" });
  if (p.c > LIMITS.C_MAX) throw new ApiError("OUT_OF_RANGE", `C 超过上限 ${LIMITS.C_MAX}`, { param: "c" });
  if (p.v > LIMITS.V_MAX) throw new ApiError("OUT_OF_RANGE", `V 超过上限 ${LIMITS.V_MAX}`, { param: "v" });
}

export function validateFrequency(f: unknown): asserts f is number {
  assertFinite("f", f);
  if (f <= 0) throw new ApiError("INVALID_PARAM", "频率必须为正数", { param: "f", value: f });
  if (f > LIMITS.F_MAX) throw new ApiError("OUT_OF_RANGE", `频率超过上限 ${LIMITS.F_MAX}`, { param: "f" });
}

function assertFiniteResult(values: Record<string, number>): void {
  for (const [k, v] of Object.entries(values)) {
    if (!Number.isFinite(v)) {
      throw new ApiError("NON_FINITE_RESULT", `中间量 ${k} 非有限值，超出可计算数值范围`, { field: k });
    }
  }
}

export interface PointResult {
  frequencyHz: number;
  omega: number;
  z: Phasor;          // 总阻抗 Z = R + j(ωL - 1/(ωC))
  zReactance: number; // X = ωL - 1/(ωC)
  xL: number;         // ωL
  xC: number;         // -1/(ωC)（含负号）
  current: Phasor;    // I = V/Z，V 相位固定为 0
  vr: Phasor;         // I*R
  vl: Phasor;         // I*jωL
  vc: Phasor;         // I*(-j/(ωC))
  kvlResidual: number; // |VR+VL+VC - V|，应 ~0
  pActiveW: number;   // |I|^2 * R（有效值口径）
  qReactiveVar: number; // |I|^2 * X，符号与总电抗一致
  sApparentVA: number;  // V * |I|
}

export function computePoint(p: CircuitParams, f: number): PointResult {
  validateCircuitParams(p);
  validateFrequency(f);
  const omega = 2 * Math.PI * f;
  const xL = omega * p.l;
  const xC = -1 / (omega * p.c);
  const x = xL + xC;
  const z: Complex = { re: p.r, im: x };
  const source: Complex = { re: p.v, im: 0 };
  const i: Complex = p.v === 0 ? { re: 0, im: 0 } : cdiv(source, z);
  const vr = cmul(i, { re: p.r, im: 0 });
  const vl = cmul(i, { re: 0, im: xL });
  const vc = cmul(i, { re: 0, im: xC });
  const sum = cadd(cadd(vr, vl), vc);
  const kvlResidual = cabs({ re: sum.re - p.v, im: sum.im });
  const iMag2 = i.re * i.re + i.im * i.im;
  const pActive = iMag2 * p.r;
  const qReactive = iMag2 * x;
  const sApparent = p.v * cabs(i);
  assertFiniteResult({ omega, xL, xC, iRe: i.re, iIm: i.im, pActive, qReactive });
  return {
    frequencyHz: f,
    omega,
    z: toPhasor(z),
    zReactance: x,
    xL,
    xC,
    current: toPhasor(i),
    vr: toPhasor(vr),
    vl: toPhasor(vl),
    vc: toPhasor(vc),
    kvlResidual,
    pActiveW: pActive,
    qReactiveVar: qReactive,
    sApparentVA: sApparent,
  };
}

export interface Characteristics {
  omega0: number;      // 1/sqrt(LC)
  f0Hz: number;        // omega0/(2π)
  qFactor: number;     // omega0*L/R
  resonanceCurrentA: number; // V/R（谐振电流有效值，也是扫频最大值）
  resonancePowerW: number;   // V^2/R（零电源时为 0，表示电路决定的理论值）
  omegaLow: number;
  omegaHigh: number;
  fLowHz: number;      // 半功率点（电阻功率 = 谐振功率一半）
  fHighHz: number;
  bandwidthHz: number; // R/(2πL)
  bandwidthCheckHz: number; // fHigh - fLow，应与 bandwidthHz 一致
}

export function computeCharacteristics(p: CircuitParams): Characteristics {
  validateCircuitParams(p);
  const omega0 = 1 / Math.sqrt(p.l * p.c);
  const f0 = omega0 / (2 * Math.PI);
  const q = (omega0 * p.l) / p.r;
  const s = Math.sqrt(p.r * p.r + (4 * p.l) / p.c);
  const omegaLow = 2 / (p.c * (s + p.r));
  const omegaHigh = (s + p.r) / (2 * p.l);
  const fLow = omegaLow / (2 * Math.PI);
  const fHigh = omegaHigh / (2 * Math.PI);
  const bw = p.r / (2 * Math.PI * p.l);
  assertFiniteResult({ omega0, f0, q, omegaLow, omegaHigh });
  return {
    omega0,
    f0Hz: f0,
    qFactor: q,
    resonanceCurrentA: p.v / p.r,
    resonancePowerW: (p.v * p.v) / p.r,
    omegaLow,
    omegaHigh,
    fLowHz: fLow,
    fHighHz: fHigh,
    bandwidthHz: bw,
    bandwidthCheckHz: fHigh - fLow,
  };
}

export type SweepSpec =
  | { mode: "list"; frequencies: number[] }
  | { mode: "linear"; startHz: number; endHz: number; count: number }
  | { mode: "log"; startHz: number; endHz: number; count: number };

export function buildGrid(spec: SweepSpec): number[] {
  if (spec.mode === "list") {
    if (!Array.isArray(spec.frequencies) || spec.frequencies.length === 0) {
      throw new ApiError("INVALID_PARAM", "列表模式需要非空 frequencies 数组");
    }
    if (spec.frequencies.length > LIMITS.SWEEP_POINTS_MAX) {
      throw new ApiError("OUT_OF_RANGE", `扫频点数超过上限 ${LIMITS.SWEEP_POINTS_MAX}`);
    }
    for (const f of spec.frequencies) validateFrequency(f);
    return [...spec.frequencies]; // 保留输入顺序
  }
  validateFrequency(spec.startHz);
  validateFrequency(spec.endHz);
  if (spec.endHz < spec.startHz) {
    throw new ApiError("INVALID_PARAM", "endHz 必须不小于 startHz");
  }
  if (!Number.isInteger(spec.count) || spec.count < 2) {
    throw new ApiError("INVALID_PARAM", "自动网格点数 count 必须为 >=2 的整数");
  }
  if (spec.count > LIMITS.SWEEP_POINTS_MAX) {
    throw new ApiError("OUT_OF_RANGE", `扫频点数超过上限 ${LIMITS.SWEEP_POINTS_MAX}`);
  }
  const n = spec.count;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1);
    const f =
      spec.mode === "linear"
        ? spec.startHz + (spec.endHz - spec.startHz) * t
        : spec.startHz * Math.pow(spec.endHz / spec.startHz, t);
    out.push(f);
  }
  // 强制端点精确包含
  out[0] = spec.startHz;
  out[n - 1] = spec.endHz;
  return out;
}

export interface SweepSummary {
  characteristics: Characteristics;
  sampledPeak: {
    frequencyHz: number;
    currentMagA: number;
    note: string;
  };
  gridResolutionHz: { minStep: number; maxStep: number };
}

export function summarizeSweep(p: CircuitParams, freqs: number[], points: PointResult[]): SweepSummary {
  let peakIdx = 0;
  for (let k = 1; k < points.length; k++) {
    if (points[k].current.mag > points[peakIdx].current.mag) peakIdx = k;
  }
  let minStep = Infinity;
  let maxStep = 0;
  for (let k = 1; k < freqs.length; k++) {
    const d = Math.abs(freqs[k] - freqs[k - 1]);
    if (d < minStep) minStep = d;
    if (d > maxStep) maxStep = d;
  }
  if (!Number.isFinite(minStep)) minStep = 0;
  return {
    characteristics: computeCharacteristics(p),
    sampledPeak: {
      frequencyHz: freqs[peakIdx],
      currentMagA: points[peakIdx].current.mag,
      note: "离散采样峰值，非精确谐振点；精确谐振见 characteristics（解析公式）",
    },
    gridResolutionHz: { minStep, maxStep },
  };
}
