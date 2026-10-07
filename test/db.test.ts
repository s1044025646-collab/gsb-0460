import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

process.env.RLC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlc-test-"));

import * as db from "../src/db";
import * as service from "../src/service";

after(() => {
  db.closeDb();
  fs.rmSync(process.env.RLC_DATA_DIR!, { recursive: true, force: true });
});

test("保存电路 + 幂等：相同 clientRequestId 不重复插入", () => {
  const a = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t1", clientRequestId: "req-1" });
  const b = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t1", clientRequestId: "req-1" });
  assert.equal(a.idempotent, false);
  assert.equal(b.idempotent, true);
  assert.equal(a.circuit.id, b.circuit.id);
});

test("扫频报告原子保存，重启（重开连接）后可读取", () => {
  const { circuit } = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t2" });
  const { report, points } = service.runSweep(circuit.id, { mode: "linear", startHz: 1, endHz: 100, count: 5 });
  assert.equal(points.length, 5);
  db.closeDb();
  const view = service.getReportView(report.id);
  assert.equal(view.points.length, 5);
  assert.equal(view.points[0].frequencyHz, 1);
  assert.equal(view.points[4].frequencyHz, 100);
  assert.ok(view.summary);
});

test("扫频幂等：相同 clientRequestId 返回已有报告", () => {
  const { circuit } = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t3" });
  const s1 = service.runSweep(circuit.id, { mode: "linear", startHz: 1, endHz: 10, count: 3 }, "sw-1");
  const s2 = service.runSweep(circuit.id, { mode: "linear", startHz: 1, endHz: 10, count: 3 }, "sw-1");
  assert.equal(s2.idempotent, true);
  assert.equal(s1.report.id, s2.report.id);
});

test("非法批次不留下报告记录", () => {
  const { circuit } = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t4" });
  const before = db.listReports(circuit.id).length;
  assert.throws(() =>
    service.runSweep(circuit.id, { mode: "list", frequencies: [10, -5, 20] })
  );
  assert.equal(db.listReports(circuit.id).length, before);
});

test("比较两个参数版本", () => {
  const a = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "va" });
  const b = service.createCircuit({ r: 20, l: 0.1, c: 0.001, v: 10, name: "vb" });
  const cmp = service.compareCircuits(a.circuit.id, b.circuit.id);
  assert.deepEqual(cmp.diffParams.r, { a: 10, b: 20 });
  assert.ok(cmp.diffChar.qFactor);
  assert.equal(cmp.diffChar.f0Hz, undefined); // f0 不变
});

test("CSV 导出行数与表头", () => {
  const { circuit } = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "t5" });
  const { report } = service.runSweep(circuit.id, { mode: "linear", startHz: 1, endHz: 10, count: 4 });
  const view = service.getReportView(report.id);
  const csv = service.reportToCsv(view.points);
  const lines = csv.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith("f_hz,"));
});
