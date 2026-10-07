import { test } from "node:test";
import assert from "node:assert/strict";
import { characteristics, computePoint, CircuitParams } from "../src/rlc";
import { buildGrid } from "../src/grid";

const DEMO: CircuitParams = { r: 10, l: 0.1, c: 0.001, v: 10 };
const F0 = 100 / (2 * Math.PI);

const close = (a: number, b: number, tol = 1e-9): void => {
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
};

test("demo: resonance values match independent scalar formulas", () => {
  const ch = characteristics(DEMO);
  close(ch.omega0, 1 / Math.sqrt(0.1 * 0.001));
  close(ch.omega0, 100, 1e-12);
  close(ch.f0Hz, F0, 1e-12);
  close(ch.q, (100 * 0.1) / 10);
  close(ch.resonanceCurrentRms, 1);
  close(ch.resonancePowerW, 10);

  const p = computePoint(DEMO, F0);
  close(p.current.mag, 1);
  close(p.current.phaseDeg!, 0, 1e-9);
  close(p.power.activeW, 10);
  close(p.power.reactiveVar, 0, 1e-9);
  // VL = +j10, VC = -j10: cancel in sum but individually non-zero
  close(p.voltageInductor.re, 0, 1e-9);
  close(p.voltageInductor.im, 10);
  close(p.voltageCapacitor.re, 0, 1e-9);
  close(p.voltageCapacitor.im, -10);
  close(p.voltageResistor.re, 10);
});

test("demo: half-power points, bandwidth, |I|=1/sqrt(2), phases +/-45 deg", () => {
  const ch = characteristics(DEMO);
  const s = Math.sqrt(10 * 10 + (4 * 0.1) / 0.001);
  close(ch.omegaLow, 2 / (0.001 * (s + 10)));
  close(ch.omegaHigh, (s + 10) / (2 * 0.1));
  close(ch.bandwidthHz, 10 / (2 * Math.PI * 0.1));
  close(ch.fHighHz - ch.fLowHz, ch.bandwidthHz, 1e-9);
  close(ch.halfPowerCurrentRms!, 1 / Math.SQRT2);

  const lo = computePoint(DEMO, ch.fLowHz);
  const hi = computePoint(DEMO, ch.fHighHz);
  close(lo.current.mag, 1 / Math.SQRT2, 1e-9);
  close(hi.current.mag, 1 / Math.SQRT2, 1e-9);
  close(lo.current.phaseDeg!, 45, 1e-9); // capacitive below resonance: current leads
  close(hi.current.phaseDeg!, -45, 1e-9); // inductive above resonance: current lags
  close(lo.power.activeW, 5, 1e-9);
  close(hi.power.activeW, 5, 1e-9);
});

test("phasor closure (KVL) and power balance at off-resonance frequency", () => {
  const p = computePoint(DEMO, 30);
  const vsum = {
    re: p.voltageResistor.re + p.voltageInductor.re + p.voltageCapacitor.re,
    im: p.voltageResistor.im + p.voltageInductor.im + p.voltageCapacitor.im,
  };
  close(vsum.re, 10, 1e-9);
  close(vsum.im, 0, 1e-9);
  assert.ok(p.checks.kvlOk && p.checks.powerOk);
  // S = V * conj(I) == P + jQ
  close(p.power.activeW, 10 * p.current.re, 1e-9);
  close(p.power.reactiveVar, -10 * p.current.im, 1e-9);
  // reactive power sign follows total reactance
  assert.equal(Math.sign(p.power.reactiveVar), Math.sign(p.reactance.xTotal));
  // magnitudes alone must NOT add up to source voltage off resonance
  const magSum = p.voltageResistor.mag + p.voltageInductor.mag + p.voltageCapacitor.mag;
  assert.ok(magSum > 10);
});

test("zero source: currents/voltages zero, phases undefined, impedance phase valid", () => {
  const p = computePoint({ ...DEMO, v: 0 }, F0);
  assert.equal(p.current.mag, 0);
  assert.equal(p.current.phaseDeg, null);
  assert.equal(p.voltageResistor.phaseDeg, null);
  assert.equal(p.voltageInductor.phaseDeg, null);
  assert.equal(p.voltageCapacitor.phaseDeg, null);
  assert.equal(p.power.activeW, 0);
  const off = computePoint({ ...DEMO, v: 0 }, 30);
  assert.ok(off.impedance.phaseDeg !== null);
  const ch = characteristics({ ...DEMO, v: 0 });
  close(ch.omega0, 100, 1e-12);
  assert.equal(ch.halfPowerCurrentRms, null);
});

test("validation: rejects R=0, L=0, C=0, negative, non-finite, bad frequency", () => {
  for (const bad of [
    { ...DEMO, r: 0 },
    { ...DEMO, l: 0 },
    { ...DEMO, c: 0 },
    { ...DEMO, r: -1 },
    { ...DEMO, r: NaN },
    { ...DEMO, r: Infinity },
    { ...DEMO, v: -1 },
  ]) {
    assert.throws(() => computePoint(bad, 10), /must be|out of supported range/);
  }
  assert.throws(() => computePoint(DEMO, 0), /> 0 Hz/);
  assert.throws(() => computePoint(DEMO, -5), /> 0 Hz/);
  assert.throws(() => computePoint(DEMO, NaN), /finite/);
  assert.throws(() => characteristics({ ...DEMO, c: 0 }), /must be/);
});

test("grids: endpoints included, min two points, list keeps order", () => {
  const lin = buildGrid({ mode: "linear", start: 10, end: 20, count: 3 });
  assert.deepEqual(lin, [10, 15, 20]);
  const log = buildGrid({ mode: "log", start: 1, end: 100, count: 3 });
  close(log[0], 1, 1e-15);
  close(log[1], 10, 1e-9);
  close(log[2], 100, 1e-15);
  const list = buildGrid({ mode: "list", freqs: [30, 5, 12] });
  assert.deepEqual(list, [30, 5, 12]);
  assert.throws(() => buildGrid({ mode: "linear", start: 1, end: 10, count: 1 }), />= 2/);
  assert.throws(() => buildGrid({ mode: "log", start: 0, end: 10, count: 5 }), /> 0 Hz/);
  assert.throws(() => buildGrid({ mode: "list", freqs: [] }), /non-empty/);
});

test("phase convention: half-open (-180, 180] degrees", () => {
  const p = computePoint(DEMO, 1); // capacitive: Z phase in (-90, 0)
  assert.ok(p.impedance.phaseDeg! > -90 && p.impedance.phaseDeg! < 0);
  const p2 = computePoint(DEMO, 1000); // inductive
  assert.ok(p2.impedance.phaseDeg! > 0 && p2.impedance.phaseDeg! < 90);
});
