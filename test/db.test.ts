import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as pathMod from "node:path";
import { RlcDb, sweepToCsv } from "../src/db";
import { PointResult } from "../src/rlc";

const DEMO = { r: 10, l: 0.1, c: 0.001, v: 10 };

test("sweep persistence, idempotency, frozen versions", () => {
  const db = new RlcDb(":memory:");
  const v1 = db.saveCircuit(DEMO, "t");
  const s1 = db.submitSweep(v1.id, { mode: "linear", start: 10, end: 20, count: 3 }, "key-1") as {
    sweepId: number;
    points: PointResult[];
  };
  assert.equal(s1.points.length, 3);
  assert.deepEqual(
    s1.points.map((p) => p.freqHz),
    [10, 15, 20],
  );

  // idempotent replay returns same sweep, no duplicate
  const s2 = db.submitSweep(v1.id, { mode: "linear", start: 10, end: 20, count: 3 }, "key-1") as {
    sweepId: number;
    idempotentReplay?: boolean;
  };
  assert.equal(s2.sweepId, s1.sweepId);
  assert.equal(s2.idempotentReplay, true);
  assert.equal((db.listSweeps(v1.id) as unknown[]).length, 1);

  // modify params -> new version; old sweep keeps frozen params
  const v2 = db.saveCircuit({ ...DEMO, r: 20 }, undefined, v1.circuitId);
  assert.equal(v2.version, 2);
  const old = db.getSweep(s1.sweepId) as { points: PointResult[]; circuitVersionId: number };
  assert.equal(old.circuitVersionId, v1.id);
  const p10 = old.points[0];
  const iMag = 10 / Math.hypot(10, 2 * Math.PI * 10 * 0.1 - 1 / (2 * Math.PI * 10 * 0.001));
  assert.ok(Math.abs(p10.current.mag - iMag) < 1e-9);

  // invalid batch leaves nothing behind
  const before = (db.listSweeps(v2.id) as unknown[]).length;
  assert.throws(() => db.submitSweep(v2.id, { mode: "linear", start: 1, end: 10, count: 1 }), />= 2/);
  assert.equal((db.listSweeps(v2.id) as unknown[]).length, before);

  // compare versions
  const cmp = db.compareVersions(v1.id, v2.id) as { paramDiff: Record<string, unknown> };
  assert.ok("r" in cmp.paramDiff);

  // csv export
  const csv = sweepToCsv(old as { points: PointResult[] });
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("freq_hz,z_re"));
  db.close();
});

test("restart: data readable from disk without recompute", () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "rlc-test-"));
  const file = pathMod.join(dir, "t.db");
  {
    const db = new RlcDb(file);
    const v = db.saveCircuit(DEMO);
    db.submitSweep(v.id, { mode: "list", freqs: [5, 15] }, "k");
    db.close();
  }
  {
    const db = new RlcDb(file);
    const v = db.latestVersion(1);
    assert.equal(v.params.r, 10);
    const sweeps = db.listSweeps(v.id) as { id: number }[];
    assert.equal(sweeps.length, 1);
    const s = db.getSweep(sweeps[0].id) as { points: PointResult[] };
    assert.equal(s.points.length, 2);
    assert.equal(s.points[0].freqHz, 5);
    db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
