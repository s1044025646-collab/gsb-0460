import { toErrorBody } from "./core/errors";
import { PointResult, SweepSpec } from "./core/rlc";
import * as service from "./service";
import * as db from "./db";
import { startServer } from "./api";

function fmt(x: number | null, digits = 6): string {
  if (x === null) return "undefined";
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return x.toExponential(4);
  return String(Number(x.toFixed(digits)));
}

function pointLine(p: PointResult): string {
  const ph = (x: number | null) => (x === null ? "  undef" : x.toFixed(2).padStart(7));
  return [
    fmt(p.frequencyHz).padStart(12),
    fmt(p.z.re).padStart(10),
    fmt(p.z.im).padStart(12),
    fmt(p.current.mag).padStart(12),
    ph(p.current.phaseDeg),
    `VR=(${fmt(p.vr.re)},${fmt(p.vr.im)}j)`.padStart(26),
    `VL=(${fmt(p.vl.re)},${fmt(p.vl.im)}j)`.padStart(26),
    `VC=(${fmt(p.vc.re)},${fmt(p.vc.im)}j)`.padStart(26),
    fmt(p.pActiveW).padStart(12),
    fmt(p.qReactiveVar).padStart(12),
  ].join(" ");
}

const POINT_HEADER = [
  "f(Hz)".padStart(12),
  "Z.re(Ω)".padStart(10),
  "Z.im(Ω)".padStart(12),
  "|I|(A)".padStart(12),
  "∠I(°)".padStart(7),
  "VR(V)".padStart(26),
  "VL(V)".padStart(26),
  "VC(V)".padStart(26),
  "P(W)".padStart(12),
  "Q(var)".padStart(12),
].join(" ");

function printPoints(points: PointResult[]) {
  console.log(POINT_HEADER);
  for (const p of points) console.log(pointLine(p));
}

function printCharacteristics(c: ReturnType<typeof service.getCharacteristics>) {
  console.log(`谐振角频率 omega0 = ${fmt(c.omega0)} rad/s`);
  console.log(`谐振频率   f0     = ${fmt(c.f0Hz)} Hz`);
  console.log(`品质因数   Q      = ${fmt(c.qFactor)}`);
  console.log(`谐振电流   I0     = ${fmt(c.resonanceCurrentA)} A (RMS)`);
  console.log(`谐振功率   P0     = ${fmt(c.resonancePowerW)} W`);
  console.log(`半功率点   fLow   = ${fmt(c.fLowHz)} Hz, fHigh = ${fmt(c.fHighHz)} Hz`);
  console.log(`带宽       BW     = ${fmt(c.bandwidthHz)} Hz (核验 fHigh-fLow = ${fmt(c.bandwidthCheckHz)})`);
}

function argMap(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

const USAGE = `用法: node dist/cli.js <命令> [选项]
命令:
  serve [--port N]                      启动 API 服务（默认自动选择空闲端口）
  new --r R --l L --c C --v V [--name N] [--req ID]   保存电路，输出电路 id
  list                                  列出所有电路
  point --circuit ID --f F              单点计算
  sweep --circuit ID --mode linear|log --start F --end F --count N [--req ID]
  sweep --circuit ID --mode list --freqs f1,f2,...    列表扫频（保留输入顺序）
  report --id ID [--csv]                查看报告（含每个点的相量与功率）
  characteristics --circuit ID          查看特征频率（解析公式）
  compare --a ID --b ID                 比较两个参数版本
  export --id ID --format json|csv      导出报告
  demo                                  运行内置演示 (R=10, L=0.1, C=0.001, V=10)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = argMap(rest);
  switch (cmd) {
    case "serve": {
      const port = args.port ? Number(args.port) : undefined;
      const { port: actual } = await startServer(port);
      console.log(`RLC API 服务已启动: http://127.0.0.1:${actual}`);
      return; // 保持进程
    }
    case "new": {
      const { circuit, idempotent } = service.createCircuit({
        r: Number(args.r), l: Number(args.l), c: Number(args.c), v: Number(args.v),
        name: args.name, clientRequestId: args.req,
      });
      console.log(`电路已保存 id=${circuit.id}${idempotent ? "（幂等命中已有记录）" : ""}`);
      console.log(JSON.stringify(circuit, null, 2));
      break;
    }
    case "list": {
      for (const c of db.listCircuits()) {
        console.log(`id=${c.id} name=${c.name} R=${c.r}Ω L=${c.l}H C=${c.c}F V=${c.v}V created=${c.created_at}`);
      }
      break;
    }
    case "point": {
      const { point, report } = service.singlePoint(Number(args.circuit), Number(args.f));
      console.log(`报告 id=${report.id}`);
      printPoints([point]);
      break;
    }
    case "sweep": {
      let spec: SweepSpec;
      if (args.mode === "list") {
        spec = { mode: "list", frequencies: String(args.freqs ?? "").split(",").filter(Boolean).map(Number) };
      } else if (args.mode === "linear" || args.mode === "log") {
        spec = { mode: args.mode, startHz: Number(args.start), endHz: Number(args.end), count: Number(args.count) };
      } else {
        throw new Error("--mode 必须是 list | linear | log");
      }
      const { report, points, summary } = service.runSweep(Number(args.circuit), spec, args.req);
      console.log(`扫频报告 id=${report.id}，共 ${points.length} 点`);
      printPoints(points);
      console.log(`\n采样峰值: f=${fmt(summary.sampledPeak.frequencyHz)} Hz, |I|=${fmt(summary.sampledPeak.currentMagA)} A（${summary.sampledPeak.note}）`);
      console.log(`网格步长: min=${fmt(summary.gridResolutionHz.minStep)} Hz, max=${fmt(summary.gridResolutionHz.maxStep)} Hz`);
      console.log("\n解析特征频率:");
      printCharacteristics(summary.characteristics);
      break;
    }
    case "report": {
      const view = service.getReportView(Number(args.id));
      printPoints(view.points);
      if (view.summary) {
        console.log("\n解析特征频率:");
        printCharacteristics(view.summary.characteristics);
      }
      break;
    }
    case "characteristics": {
      printCharacteristics(service.getCharacteristics(Number(args.circuit)));
      break;
    }
    case "compare": {
      const r = service.compareCircuits(Number(args.a), Number(args.b));
      console.log("参数差异:", JSON.stringify(r.diffParams));
      console.log("特征差异:", JSON.stringify(r.diffChar, null, 2));
      break;
    }
    case "export": {
      const view = service.getReportView(Number(args.id));
      if (args.format === "csv") console.log(service.reportToCsv(view.points));
      else console.log(JSON.stringify(view, null, 2));
      break;
    }
    case "demo": {
      console.log("演示: R=10Ω, L=0.1H, C=0.001F, V=10V(RMS)");
      const { circuit } = service.createCircuit({ r: 10, l: 0.1, c: 0.001, v: 10, name: "demo" });
      console.log(`电路 id=${circuit.id}`);
      console.log("\n-- 谐振点单点计算 f0 = 1/(2π√(LC)) ≈ 15.91549431 Hz (omega0=100 rad/s) --");
      const f0 = 1 / (2 * Math.PI * Math.sqrt(0.1 * 0.001));
      const { point } = service.singlePoint(circuit.id, f0);
      printPoints([point]);
      console.log("\n-- 对数扫频 1 Hz ~ 1 kHz, 11 点 --");
      const { points, summary, report } = service.runSweep(circuit.id, {
        mode: "log", startHz: 1, endHz: 1000, count: 11,
      });
      console.log(`报告 id=${report.id}`);
      printPoints(points);
      console.log("\n解析特征频率:");
      printCharacteristics(summary.characteristics);
      break;
    }
    default:
      process.stdout.write(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(JSON.stringify(toErrorBody(err), null, 2));
    process.exitCode = 1;
  })
  .finally(() => {
    // serve 模式保持进程；其他命令退出前关闭数据库
    if (process.argv[2] !== "serve") db.closeDb();
  });
