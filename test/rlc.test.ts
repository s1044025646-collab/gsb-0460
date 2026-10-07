import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGrid,
  computeCharacteristics,
  computePoint,
  phaseDeg,
  TOL_REL,
} from "../src/core/rlc";
import { ApiError } from "../src/core/errors";

const DEMO = { r: 10, l: 0.1, c: 0.001, v: 10 };
const F0 = 1 / (2 * Math.PI * Math.sqrt(DEMO.l * DEMO.c)); // omega0 = 100 rad/s

function closeTo(actual: number, expected: number, rel = 1e-9) {
  const tol = rel * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} ≈ ${expected} (tol ${tol})`);
}

test("演示电路谐振点：omega0=100, I=1A, P=10W, VL=+j10, VC=-j10", () => {
  const p = computePoint(DEMO, F0);
  closeTo(p.omega, 100);
  closeTo(p.z.re, 10);
  closeTo(p.z.im, 0, 1e-12);
  closeTo(p.current.mag, 1);
  closeTo(p.current.phaseDeg!, 0, 1e-9);
  closeTo(p.pActiveW, 10);
  closeTo(p.qReactiveVar, 0, 1e-12);
  // VL = +j10, VC = -j10（各自非零但相互抵消）
  closeTo(p.vl.re, 0, 1e-12);
  closeTo(p.vl.im, 10);
  closeTo(p.vc.re, 0, 1e-12);
  closeTo(p.vc.im, -10);
  closeTo(p.vr.mag, 10);
});

test("KVL 相量闭合：VR+VL+VC = V∠0（多频率）", () => {
  for (const f of [1, 5, F0, 50, 500, 10000]) {
    const p = computePoint(DEMO, f);
    const sumRe = p.vr.re + p.vl.re + p.vc.re;
    const sumIm = p.vr.im + p.vl.im + p.vc.im;
    closeTo(sumRe, DEMO.v);
    closeTo(sumIm, 0, 1e-12);
    assert.ok(p.kvlResidual < 1e-9);
  }
});

test("功率账目：P=|I|²R，Q 符号与总电抗一致，S²=P²+Q²", () => {
  for (const f of [3, F0, 80]) {
    const p = computePoint(DEMO, f);
    closeTo(p.pActiveW, p.current.mag ** 2 * DEMO.r);
    closeTo(p.qReactiveVar, p.current.mag ** 2 * p.zReactance);
    assert.equal(Math.sign(p.qReactiveVar), Math.sign(p.zReactance) || 0);
    closeTo(p.sApparentVA ** 2, p.pActiveW ** 2 + p.qReactiveVar ** 2, 1e-9);
    // 谐振以下容性 Q<0，以上感性 Q>0
    if (f < F0) assert.ok(p.qReactiveVar < 0);
    if (f > F0) assert.ok(p.qReactiveVar > 0);
  }
});

test("特征频率解析公式与带宽核验", () => {
  const c = computeCharacteristics(DEMO);
  closeTo(c.omega0, 100);
  closeTo(c.f0Hz, 100 / (2 * Math.PI));
  closeTo(c.qFactor, 1);
  closeTo(c.resonanceCurrentA, 1);
  closeTo(c.resonancePowerW, 10); // V²/R = 100/10
  closeTo(c.bandwidthHz, 10 / (2 * Math.PI * 0.1));
  closeTo(c.bandwidthCheckHz, c.bandwidthHz, 1e-12);
  // 半功率点：|I| = 1/√2，相位 ±45°
  const lo = computePoint(DEMO, c.fLowHz);
  const hi = computePoint(DEMO, c.fHighHz);
  closeTo(lo.current.mag, 1 / Math.SQRT2, 1e-9);
  closeTo(hi.current.mag, 1 / Math.SQRT2, 1e-9);
  closeTo(lo.current.phaseDeg!, 45, 1e-9);
  closeTo(hi.current.phaseDeg!, -45, 1e-9);
  // 半功率点功率 = 谐振功率一半
  closeTo(lo.pActiveW, c.resonancePowerW / 2, 1e-9);
  closeTo(hi.pActiveW, c.resonancePowerW / 2, 1e-9);
});

test("零电源：电流电压全零、相位未定义，阻抗相位仍有效", () => {
  const p0 = { ...DEMO, v: 0 };
  const p = computePoint(p0, 50);
  assert.equal(p.current.mag, 0);
  assert.equal(p.current.phaseDeg, null);
  assert.equal(p.vr.mag, 0);
  assert.equal(p.vl.mag, 0);
  assert.equal(p.vc.mag, 0);
  assert.equal(p.pActiveW, 0);
  assert.ok(p.z.phaseDeg !== null); // 阻抗相位有效
  // 特征频率仍由电路决定
  const c = computeCharacteristics(p0);
  closeTo(c.omega0, 100);
  assert.equal(c.resonanceCurrentA, 0);
});

test("相位区间 (-180, 180]，零模相位为 null", () => {
  assert.equal(phaseDeg({ re: 0, im: 0 }), null);
  assert.equal(phaseDeg({ re: -1, im: 0 }), 180);
  closeTo(phaseDeg({ re: 0, im: -1 })!, -90);
  closeTo(phaseDeg({ re: 0, im: 1 })!, 90);
});

test("参数校验：拒绝 R=0 / L=0 / C=0 / 负频率 / 非有限值", () => {
  for (const bad of [
    { r: 0, l: 0.1, c: 0.001, v: 10 },
    { r: 10, l: 0, c: 0.001, v: 10 },
    { r: 10, l: 0.1, c: 0, v: 10 },
    { r: -1, l: 0.1, c: 0.001, v: 10 },
    { r: 10, l: 0.1, c: 0.001, v: -1 },
    { r: NaN, l: 0.1, c: 0.001, v: 10 },
    { r: 10, l: Infinity, c: 0.001, v: 10 },
  ]) {
    assert.throws(() => computePoint(bad, 50), ApiError);
  }
  assert.throws(() => computePoint(DEMO, 0), ApiError);
  assert.throws(() => computePoint(DEMO, -5), ApiError);
  assert.throws(() => computePoint(DEMO, NaN), ApiError);
});

test("网格：线性/对数端点精确包含，至少两点，列表保留顺序", () => {
  const lin = buildGrid({ mode: "linear", startHz: 10, endHz: 100, count: 10 });
  assert.equal(lin[0], 10);
  assert.equal(lin[9], 100);
  assert.equal(lin.length, 10);
  const log = buildGrid({ mode: "log", startHz: 1, endHz: 1000, count: 4 });
  assert.equal(log[0], 1);
  assert.equal(log[3], 1000);
  closeTo(log[1], 10);
  closeTo(log[2], 100);
  const list = buildGrid({ mode: "list", frequencies: [50, 3, 200, 7] });
  assert.deepEqual(list, [50, 3, 200, 7]); // 保留输入顺序
  assert.throws(() => buildGrid({ mode: "linear", startHz: 1, endHz: 10, count: 1 }), ApiError);
  assert.throws(() => buildGrid({ mode: "list", frequencies: [] }), ApiError);
  assert.throws(() => buildGrid({ mode: "linear", startHz: 1, endHz: 10, count: 10001 }), ApiError);
});

test("独立标量公式核对：|Z|=√(R²+X²)，|I|=V/|Z|，φ=-atan2(X,R) 电流相位", () => {
  const f = 40;
  const w = 2 * Math.PI * f;
  const x = w * DEMO.l - 1 / (w * DEMO.c);
  const zmag = Math.sqrt(DEMO.r ** 2 + x ** 2);
  const p = computePoint(DEMO, f);
  closeTo(p.z.mag, zmag);
  closeTo(p.current.mag, DEMO.v / zmag);
  closeTo(p.current.phaseDeg!, (-Math.atan2(x, DEMO.r) * 180) / Math.PI, 1e-9);
  closeTo(p.vr.mag, (DEMO.v / zmag) * DEMO.r);
  closeTo(p.vl.mag, (DEMO.v / zmag) * w * DEMO.l);
  closeTo(p.vc.mag, (DEMO.v / zmag) / (w * DEMO.c));
  assert.ok(TOL_REL > 0);
});

test("电容电抗符号：xC 为负，低频时 Z 虚部为负（容性）", () => {
  const p = computePoint(DEMO, 1);
  assert.ok(p.xC < 0);
  assert.ok(p.z.im < 0);
  const p2 = computePoint(DEMO, 10000);
  assert.ok(p2.z.im > 0); // 高频感性
});
