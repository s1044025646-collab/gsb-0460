import * as http from "node:http";
import { AddressInfo } from "node:net";
import { RlcDb, sweepToCsv } from "./db";
import { ApiError } from "./errors";
import { CircuitParams, PointResult } from "./rlc";
import { SweepRequest } from "./grid";

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (params: Record<string, string>, body: unknown, query: URLSearchParams) => Promise<unknown> | unknown;
}

const routes: Route[] = [];

function route(method: string, pathPattern: string, handler: Route["handler"]): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      pathPattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

const num = (x: unknown): number => {
  const n = typeof x === "string" ? Number(x) : (x as number);
  return n;
};

function parseParams(body: unknown): CircuitParams {
  const b = (body ?? {}) as Record<string, unknown>;
  return { r: num(b.r), l: num(b.l), c: num(b.c), v: num(b.v ?? 0) };
}

function parseSweepRequest(body: unknown): { req: SweepRequest; key?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const req: SweepRequest = { mode: b.mode as SweepRequest["mode"] };
  if (b.freqs !== undefined) req.freqs = (b.freqs as unknown[]).map(num);
  if (b.start !== undefined) req.start = num(b.start);
  if (b.end !== undefined) req.end = num(b.end);
  if (b.count !== undefined) req.count = num(b.count);
  return { req, key: b.idempotencyKey as string | undefined };
}

export function createServer(db: RlcDb): http.Server {
  routes.length = 0;

  route("GET", "/api/health", () => ({ ok: true }));

  route("GET", "/api/circuits", () => db.listCircuits());

  route("POST", "/api/circuits", (_params, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return db.saveCircuit(parseParams(body), b.name as string | undefined);
  });

  route("POST", "/api/circuits/:circuitId/versions", (params, body) =>
    db.saveCircuit(parseParams(body), undefined, Number(params.circuitId)),
  );

  route("GET", "/api/circuits/:circuitId/versions", (params) => db.listVersions(Number(params.circuitId)));

  route("GET", "/api/versions/:versionId", (params) => db.getVersion(Number(params.versionId)));

  route("POST", "/api/versions/:versionId/point", (params, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return db.point(Number(params.versionId), num(b.f));
  });

  route("POST", "/api/versions/:versionId/sweeps", (params, body) => {
    const { req, key } = parseSweepRequest(body);
    return db.submitSweep(Number(params.versionId), req, key);
  });

  route("GET", "/api/versions/:versionId/sweeps", (params) => db.listSweeps(Number(params.versionId)));

  route("GET", "/api/versions/:versionId/characteristics", (params) =>
    db.characteristics(Number(params.versionId)),
  );

  route("GET", "/api/sweeps/:sweepId", (params) => db.getSweep(Number(params.sweepId)));

  route("GET", "/api/sweeps/:sweepId/export", (params, _body, query) => {
    const format = query.get("format") ?? "json";
    const sweep = db.getSweep(Number(params.sweepId)) as { points: PointResult[] };
    if (format === "csv") return { __raw: sweepToCsv(sweep), contentType: "text/csv; charset=utf-8" };
    if (format === "json") return sweep;
    throw new ApiError("VALIDATION_ERROR", `unknown export format: ${format}`, 400);
  });

  route("GET", "/api/compare", (_params, _body, query) =>
    db.compareVersions(Number(query.get("a")), Number(query.get("b"))),
  );

  return http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown, contentType = "application/json; charset=utf-8"): void => {
      const text = contentType.startsWith("application/json") ? JSON.stringify(payload, null, 2) : String(payload);
      res.writeHead(status, { "content-type": contentType });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      let body: unknown = undefined;
      if (method === "POST" || method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new ApiError("BAD_REQUEST", "request body is not valid JSON", 400);
          }
        }
      }
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const result = await r.handler(params, body, url.searchParams);
        if (result && typeof result === "object" && "__raw" in (result as Record<string, unknown>)) {
          const raw = result as { __raw: string; contentType: string };
          send(200, raw.__raw, raw.contentType);
        } else {
          send(200, result);
        }
        return;
      }
      send(404, { error: { code: "NOT_FOUND", message: `${method} ${url.pathname} not found` } });
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL_ERROR", message: String((e as Error).message) } });
      }
    }
  });
}

/** Listen on the given port, or pick a free port when port is 0/undefined. */
export function startServer(db: RlcDb, port?: number): Promise<{ server: http.Server; port: number }> {
  const server = createServer(db);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
