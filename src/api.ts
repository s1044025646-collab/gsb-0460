import * as http from "http";
import { ApiError, toErrorBody } from "./core/errors";
import { SweepSpec } from "./core/rlc";
import * as service from "./service";
import * as db from "./db";

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new ApiError("BAD_REQUEST", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8") {
  const text = contentType.startsWith("application/json") ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function parseSweepSpec(body: Record<string, unknown>): SweepSpec {
  const mode = body.mode;
  if (mode === "list") return { mode: "list", frequencies: body.frequencies as number[] };
  if (mode === "linear" || mode === "log") {
    return {
      mode,
      startHz: Number(body.startHz),
      endHz: Number(body.endHz),
      count: Number(body.count),
    };
  }
  throw new ApiError("BAD_REQUEST", "mode 必须是 list | linear | log");
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // POST /circuits
      if (method === "POST" && parts.length === 1 && parts[0] === "circuits") {
        const body = await readBody(req);
        return send(res, 201, service.createCircuit(body));
      }
      // GET /circuits
      if (method === "GET" && parts.length === 1 && parts[0] === "circuits") {
        return send(res, 200, { circuits: db.listCircuits() });
      }
      // GET /circuits/:id
      if (method === "GET" && parts.length === 2 && parts[0] === "circuits") {
        return send(res, 200, { circuit: service.mustGetCircuit(Number(parts[1])) });
      }
      // GET /circuits/:id/characteristics
      if (method === "GET" && parts.length === 3 && parts[0] === "circuits" && parts[2] === "characteristics") {
        return send(res, 200, { characteristics: service.getCharacteristics(Number(parts[1])) });
      }
      // POST /circuits/:id/point {f}
      if (method === "POST" && parts.length === 3 && parts[0] === "circuits" && parts[2] === "point") {
        const body = await readBody(req);
        const result = service.singlePoint(
          Number(parts[1]),
          Number(body.f),
          typeof body.clientRequestId === "string" ? body.clientRequestId : undefined
        );
        return send(res, 201, result);
      }
      // POST /circuits/:id/sweeps
      if (method === "POST" && parts.length === 3 && parts[0] === "circuits" && parts[2] === "sweeps") {
        const body = await readBody(req);
        const spec = parseSweepSpec(body);
        const crid = typeof body.clientRequestId === "string" ? body.clientRequestId : undefined;
        const { report, points, summary, idempotent } = service.runSweep(Number(parts[1]), spec, crid);
        return send(res, 201, { report, summary, pointCount: points.length, idempotent });
      }
      // GET /circuits/:id/reports
      if (method === "GET" && parts.length === 3 && parts[0] === "circuits" && parts[2] === "reports") {
        return send(res, 200, { reports: db.listReports(Number(parts[1])) });
      }
      // GET /compare?a=1&b=2
      if (method === "GET" && parts.length === 1 && parts[0] === "compare") {
        const a = Number(url.searchParams.get("a"));
        const b = Number(url.searchParams.get("b"));
        return send(res, 200, service.compareCircuits(a, b));
      }
      // GET /reports/:id
      if (method === "GET" && parts.length === 2 && parts[0] === "reports") {
        return send(res, 200, service.getReportView(Number(parts[1])));
      }
      // GET /reports/:id/export?format=json|csv
      if (method === "GET" && parts.length === 3 && parts[0] === "reports" && parts[2] === "export") {
        const view = service.getReportView(Number(parts[1]));
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") {
          return send(res, 200, service.reportToCsv(view.points), "text/csv; charset=utf-8");
        }
        return send(res, 200, view);
      }
      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`);
    } catch (err) {
      const body = toErrorBody(err);
      const status =
        err instanceof ApiError
          ? err.code === "NOT_FOUND"
            ? 404
            : err.code === "CONFLICT"
              ? 409
              : 400
          : 500;
      send(res, status, body);
    }
  });
}

export function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const server = createServer();
  const p = port ?? (process.env.PORT ? Number(process.env.PORT) : 0); // 默认自动选择空闲端口
  return new Promise((resolve) => {
    server.listen(p, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : p;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`RLC API 服务已启动: http://127.0.0.1:${port}`);
  });
}
