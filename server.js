// server.js
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { parse } from "url";

const PORT = process.env.PORT || 8080;
const FASTAPI_URL = process.env.FASTAPI_URL;
if (!FASTAPI_URL) { console.error("FASTAPI_URL env var is required"); process.exit(1); }

const PROTOCOL_VERSION = "2024-05-14";
const SERVER_NAME = "akasha-mcp";
const SERVER_VERSION = "0.1.0";

function log(...a){ console.log("[MCP]", ...a); }

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    traditions: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    topK: { type: "number", default: 6 },
    lang: { type: "string" }
  },
  required: ["query", "traditions"]
};

// Advertise both for client compatibility
const toolSpec = {
  name: "qdrant_search",
  description: "Embed + search via Akasha FastAPI /query. Args: query, traditions (string|array), topK, lang.",
  input_schema: inputSchema,
  inputSchema:  inputSchema
};

// ---------------- Core MCP handler (shared by WS & SSE) ----------------
async function handleRpcMessage(msg, respond) {
  const { id, method } = msg || {};
  if (!method) return;

  if (method === "initialize") {
    return respond({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: {
          tools: { list: true, call: true },
          prompts: { list: true },
          resources: { list: true }
        }
      }
    });
  }

  if (method === "notifications/initialized") return respond({ jsonrpc: "2.0", id, result: { ok: true } });
  if (method === "ping")                    return respond({ jsonrpc: "2.0", id, result: { ok: true } });
  if (method === "resources/list")          return respond({ jsonrpc: "2.0", id, result: { resources: [] } });
  if (method === "prompts/list")            return respond({ jsonrpc: "2.0", id, result: { prompts: [] } });

  // tools list (cover multiple spellings)
  if (["tools/list","listTools","getTools","get_tools","list_tools"].includes(method)) {
    return respond({ jsonrpc: "2.0", id, result: { tools: [toolSpec] } });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name !== "qdrant_search") {
      return respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
    }
    try {
      const body = {
        query: args?.query,
        traditions: args?.traditions,
        topK: args?.topK ?? 6,
        lang: args?.lang ?? null
      };
      const r = await fetch(`${FASTAPI_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errTxt = await r.text();
        return respond({ jsonrpc: "2.0", id, result: { content: [{ type:"text", text:`FastAPI ${r.status}: ${errTxt}` }], isError:true }});
      }
      const data = await r.json();
      return respond({ jsonrpc: "2.0", id, result: { content: [{ type:"json", data }], isError:false }});
    } catch (e) {
      return respond({ jsonrpc: "2.0", id, result: { content: [{ type:"text", text:"Gateway error: "+String(e) }], isError:true }});
    }
  }

  return respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

// ---------------- HTTP server (discovery, health, SSE, CORS) -------------
const clients = new Map(); // cid -> { res, keepAliveInterval }

const server = http.createServer(async (req, res) => {
  const { pathname, query } = parse(req.url || "/", true);

  // --- CORS for all routes (including preflight) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Discovery: advertise SSE (Builder prefers this)
  if (pathname === "/.well-known/mcp") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const base = `${proto}://${host}`;
    const body = {
      mcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        transport: { type: "sse", url: `${base}/sse` }
      }
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Health
  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, docs: "/.well-known/mcp", ws: "/mcp", sse: "/sse", fastapi: FASTAPI_URL }));
    return;
  }

  // SSE stream (GET) — server -> client
  if (pathname === "/sse" && req.method === "GET") {
    const cid = (query?.cid || "").toString();
    if (!cid) { res.writeHead(400); res.end("cid required"); return; }

    log("SSE open cid:", cid);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*"
    });
    // flush headers (some proxies buffer otherwise)
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // initial open + periodic keepalive
    res.write(`event: open\ndata: {"ok":true}\n\n`);
    const keepAlive = setInterval(() => {
      // comment lines are valid SSE keepalive
      res.write(`: ka\n\n`);
    }, 15000);

    clients.set(cid, { res, keepAliveInterval: keepAlive });

    req.on("close", () => {
      log("SSE closed cid:", cid);
      clearInterval(keepAlive);
      clients.delete(cid);
    });
    return;
  }

  // SSE send (POST) — client -> server
  if (pathname === "/sse" && req.method === "POST") {
    const cid = (query?.cid || "").toString();
    const ch = clients.get(cid);
    if (!cid || !ch) { res.writeHead(400); res.end("invalid cid"); return; }

    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", async () => {
      try {
        const msg = JSON.parse(raw);
        log("SSE ←", msg?.method);

        const responder = (obj) => {
          const payload = JSON.stringify(obj);
          ch.res.write(`event: message\ndata: ${payload}\n\n`);
          log("SSE →", obj?.result ? (obj.result?.content ? "tools/call" : "ok") : "error");
        };

        await handleRpcMessage(msg, responder);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad json");
      }
    });
    return;
  }

  // 404
  res.writeHead(404); res.end();
});

// ---------------- WebSocket transport (fallback) -----------------------------
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) =>
    (Array.isArray(protocols) && protocols.includes("mcp")) ? "mcp" : (protocols?.[0] || undefined)
});

wss.on("connection", (ws, req) => {
  log("WS connected. protocol:", ws.protocol || "(none)", "ua:", req.headers["user-agent"]);
  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { log("WS bad json"); return; }
    log("WS ←", msg?.method);
    const responder = (obj) => { ws.send(JSON.stringify(obj)); log("WS →", obj?.result ? (obj.result?.content ? "tools/call" : "ok") : "error"); };
    handleRpcMessage(msg, responder);
  });
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "/", false);
  if (pathname !== "/mcp") { socket.destroy(); return; }
  log("HTTP upgrade → WS /mcp | proto:", req.headers["sec-websocket-protocol"]);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// make SSE/WS connections sticky & tolerant
server.keepAliveTimeout = 75_000;
server.headersTimeout   = 80_000;

server.listen(PORT, () => {
  console.log(`HTTP :${PORT} | WS /mcp | SSE /sse | Discovery /.well-known/mcp`);
});