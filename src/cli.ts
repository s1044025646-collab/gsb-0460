import * as path from "node:path";
import { RlcDb, sweepToCsv } from "./db";
import { PointResult } from "./rlc";
import { startServer } from "./server";

const DEFAULT_DB = path.join(process.cwd(), "data", "rlc.db");

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return { cmd, flags };
}

const fnum = (flags: Record<string, string>, key: string): number | undefined =>
  flags[key] !== undefined ? Number(flags[key]) : undefined;

const need = (flags: Record<string, string>, key: string): number => {
  const v = fnum(flags, key);
  if (v === undefined) throw new Error(`missing required flag --${key}`);
  return v;
};

function printPoint(p: PointResult): void {
  const ph = (x: { mag: number; phaseDeg: number | null }): string =>
    `${x.mag.toPrecision(6)} ang ${x.phaseDeg === null ? "undefined" : x.phaseDeg.toFixed(4) + " deg"}`;
  console.log(`f        = ${p.freqHz} Hz   (omega = ${p.omega} rad/s)`);
  console.log(`Z        = ${p.impedance.re} + j(${p.impedance.im}) ohm   |Z| = ${ph(p.impedance)}`);
  console.log(`I        = ${p.current.re} + j(${p.current.im}) A      |I| = ${ph(p.current)}`);
  console.log(`VR       = ${p.voltageResistor.re} + j(${p.voltageResistor.im}) V   |VR| = ${ph(p.voltageResistor)}`);
  console.log(`VL       = ${p.voltageInductor.re} + j(${p.voltageInductor.im}) V   |VL| = ${ph(p.voltageInductor)}`);
  console.log(`VC       = ${p.voltageCapacitor.re} + j(${p.voltageCapacitor.im}) V   |VC| = ${ph(p.voltageCapacitor)}`);
  console.log(`P = ${p.power.activeW} W   Q = ${p.power.reactiveVar} var   S = ${p.power.apparentVA} VA`);
  console.log(
    `checks   : KVL err=${p.checks.kvlMaxErr} (${p.checks.kvlOk ? "ok" : "FAIL"}), ` +
      `power err=${p.checks.powerMaxErr} (${p.checks.powerOk ? "ok" : "FAIL"}), tol=${p.checks.tolerance}`,
  );
}

function printSweepTable(sweep: { points: PointResult[] }): void {
  console.log(
    "freq_Hz".padStart(12) +
      "Z_mag_ohm".padStart(14) +
      "Z_phase_deg".padStart(13) +
      "I_mag_A".padStart(14) +
      "I_phase_deg".padStart(13) +
      "P_W".padStart(14) +
      "Q_var".padStart(14),
  );
  for (const p of sweep.points) {
    const zph = p.impedance.phaseDeg === null ? "undef" : p.impedance.phaseDeg.toPrecision(6);
    const iph = p.current.phaseDeg === null ? "undef" : p.current.phaseDeg.toPrecision(6);
    console.log(
      String(p.freqHz).padStart(12) +
        p.impedance.mag.toPrecision(6).padStart(14) +
        zph.padStart(13) +
        p.current.mag.toPrecision(6).padStart(14) +
        iph.padStart(13) +
        p.power.activeW.toPrecision(6).padStart(14) +
        p.power.reactiveVar.toPrecision(6).padStart(14),
    );
  }
}

const HELP = [
  "RLC sweep backend CLI (units: ohm, henry, farad, V rms, Hz)",
  "",
  "Commands:",
  "  serve [--port N] [--db PATH]                 start HTTP API (default: free port)",
  "  save-circuit --r R --l L --c C --v V [--name N] [--db PATH]",
  "  new-version --circuit ID --r R --l L --c C --v V [--db PATH]",
  "  list [--db PATH]                             list circuits",
  "  versions --circuit ID [--db PATH]",
  "  point --version VID --f FREQ [--db PATH]",
  '  sweep --version VID --mode list --freqs "f1,f2,..." [--key K] [--db PATH]',
  "  sweep --version VID --mode linear|log --start A --end B --count N [--key K] [--db PATH]",
  "  sweep-show --sweep SID [--db PATH]           print stored sweep table",
  "  characteristics --version VID [--db PATH]",
  "  compare --a VID --b VID [--db PATH]",
  "  export --sweep SID --format json|csv [--db PATH]",
  "  demo [--db PATH]                             run the R=10 L=0.1 C=0.001 V=10 demo",
  "",
].join("\n");

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const dbPath = flags.db ?? DEFAULT_DB;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "serve") {
    const db = new RlcDb(dbPath);
    const port = flags.port !== undefined ? Number(flags.port) : undefined;
    const { port: actual } = await startServer(db, port);
    console.log(`RLC API listening on http://127.0.0.1:${actual}  (db: ${dbPath})`);
    return;
  }

  const db = new RlcDb(dbPath);
  try {
    switch (cmd) {
      case "save-circuit": {
        const v = db.saveCircuit(
          { r: need(flags, "r"), l: need(flags, "l"), c: need(flags, "c"), v: fnum(flags, "v") ?? 0 },
          flags.name,
        );
        console.log(JSON.stringify(v, null, 2));
        break;
      }
      case "new-version": {
        const v = db.saveCircuit(
          { r: need(flags, "r"), l: need(flags, "l"), c: need(flags, "c"), v: fnum(flags, "v") ?? 0 },
          undefined,
          need(flags, "circuit"),
        );
        console.log(JSON.stringify(v, null, 2));
        break;
      }
      case "list":
        console.log(JSON.stringify(db.listCircuits(), null, 2));
        break;
      case "versions":
        console.log(JSON.stringify(db.listVersions(need(flags, "circuit")), null, 2));
        break;
      case "point":
        printPoint(db.point(need(flags, "version"), need(flags, "f")));
        break;
      case "sweep": {
        const mode = flags.mode;
        let req: import("./grid").SweepRequest;
        if (mode === "list") {
          const freqs = (flags.freqs ?? "")
            .split(",")
            .filter((s) => s.length > 0)
            .map(Number);
          req = { mode: "list", freqs };
        } else if (mode === "linear" || mode === "log") {
          req = { mode, start: need(flags, "start"), end: need(flags, "end"), count: need(flags, "count") };
        } else {
          throw new Error("--mode must be list|linear|log");
        }
        const sweep = db.submitSweep(need(flags, "version"), req, flags.key) as {
          sweepId: number;
          points: PointResult[];
          summary: unknown;
        };
        console.log(`sweepId = ${sweep.sweepId}`);
        printSweepTable(sweep);
        console.log(JSON.stringify(sweep.summary, null, 2));
        break;
      }
      case "sweep-show":
        printSweepTable(db.getSweep(need(flags, "sweep")) as { points: PointResult[] });
        break;
      case "characteristics":
        console.log(JSON.stringify(db.characteristics(need(flags, "version")), null, 2));
        break;
      case "compare":
        console.log(JSON.stringify(db.compareVersions(need(flags, "a"), need(flags, "b")), null, 2));
        break;
      case "export": {
        const sweep = db.getSweep(need(flags, "sweep")) as { points: PointResult[] };
        if ((flags.format ?? "json") === "csv") {
          process.stdout.write(sweepToCsv(sweep));
        } else {
          console.log(JSON.stringify(sweep, null, 2));
        }
        break;
      }
      case "demo": {
        console.log("Demo circuit: R=10 ohm, L=0.1 H, C=0.001 F, V=10 Vrms");
        const v = db.saveCircuit({ r: 10, l: 0.1, c: 0.001, v: 10 }, "demo");
        console.log(`circuitId=${v.circuitId} versionId=${v.id}`);
        console.log("\n-- characteristics --");
        console.log(JSON.stringify(db.characteristics(v.id), null, 2));
        const f0 = 100 / (2 * Math.PI);
        console.log(`\n-- point at resonance f0=${f0} Hz (omega0=100 rad/s) --`);
        printPoint(db.point(v.id, f0));
        console.log("\n-- sweep 1 Hz .. 100 Hz, log, 9 points --");
        const sweep = db.submitSweep(v.id, { mode: "log", start: 1, end: 100, count: 9 }, "demo-sweep") as {
          sweepId: number;
          points: PointResult[];
          summary: unknown;
        };
        console.log(`sweepId = ${sweep.sweepId}`);
        printSweepTable(sweep);
        console.log(JSON.stringify(sweep.summary, null, 2));
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
