import { test } from "node:test";
import assert from "node:assert/strict";
import { RlcDb } from "../src/db";
import { startServer } from "../src/server";

test("HTTP API end-to-end", async () => {
  const db = new RlcDb(":memory:");
  const { server, port } = await startServer(db);
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    // save circuit
    const c = await post("/api/circuits", { r: 10, l: 0.1, c: 0.001, v: 10, name: "api-demo" });
    assert.equal(c.status, 200);
    const vid = c.json.id;

    // single point at resonance
    const pt = await post(`/api/versions/${vid}/point`, { f: 100 / (2 * Math.PI) });
    assert.ok(Math.abs(pt.json.current.mag - 1) < 1e-9);

    // sweep with idempotency
    const sw1 = await post(`/api/versions/${vid}/sweeps`, {
      mode: "linear",
      start: 10,
      end: 20,
      count: 3,
      idempotencyKey: "api-k1",
    });
    assert.equal(sw1.status, 200);
    const sw2 = await post(`/api/versions/${vid}/sweeps`, {
      mode: "linear",
      start: 10,
      end: 20,
      count: 3,
      idempotencyKey: "api-k1",
    });
    assert.equal(sw2.json.sweepId, sw1.json.sweepId);
    assert.equal(sw2.json.idempotentReplay, true);

    // characteristics
    const ch = await fetch(`${base}/api/versions/${vid}/characteristics`).then((r) => r.json());
    assert.ok(Math.abs(ch.omega0 - 100) < 1e-9);

    // csv export
    const csv = await fetch(`${base}/api/sweeps/${sw1.json.sweepId}/export?format=csv`).then((r) => r.text());
    assert.ok(csv.includes("freq_hz"));

    // new version + compare
    const v2 = await post(`/api/circuits/${c.json.circuitId}/versions`, { r: 20, l: 0.1, c: 0.001, v: 10 });
    const cmp = await fetch(`${base}/api/compare?a=${vid}&b=${v2.json.id}`).then((r) => r.json());
    assert.ok("r" in cmp.paramDiff);

    // error codes
    const bad = await post("/api/circuits", { r: 0, l: 0.1, c: 0.001, v: 10 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "VALIDATION_ERROR");
    const notFound = await fetch(`${base}/api/sweeps/9999`);
    assert.equal(notFound.status, 404);
    const badSweep = await post(`/api/versions/${vid}/sweeps`, { mode: "linear", start: 1, end: 10, count: 1 });
    assert.equal(badSweep.status, 400);
  } finally {
    server.close();
    db.close();
  }
});
