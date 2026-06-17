import * as http from "node:http";

export interface ServerDeps {
  upstream: (body: Buffer, accept: string) => Promise<Response>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        return sendJson(res, 404, { error: { type: "not_found", message: "POST /v1/messages only" } });
      }
      const body = await collectBody(req);
      try { JSON.parse(body.toString("utf-8")); }
      catch {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } });
      }
      const accept = pickHeader(req.headers["accept"]) ?? "application/json";
      const upstream = await deps.upstream(body, accept);
      res.statusCode = upstream.status;
      for (const [k, v] of upstream.headers.entries()) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        res.setHeader(k, v);
      }
      if (!upstream.body) { res.end(); return; }
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.error("[agent] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { type: "internal_error", message: String(err) } });
      else res.end();
    }
  });
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
