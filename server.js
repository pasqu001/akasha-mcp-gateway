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
function sendJSON(wsOrRes, obj){
  if (wsOrRes?.send) wsOrRes.send(JSON.stringify(obj));
}

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

// Advertise both casing variants for client compatibility
const toolSpec = {
  name: "qdrant_search",
  description: "Embed + search via Akasha FastAPI /query. Args: query, traditions (string|array), topK, lang.",
  input_schema: inputSchema,
  inputSchema:  inputSchema
};

// ---------------- Core MCP handlers reused by both transports ----------------
async function handleRpcMessage(msg, responder) {
  // responder(resultObj) -> will deliver JSON-RPC response back on the chosen transport
  const { id, method } = msg;

  // initialize
  if (method === "initialize") {
    responder({
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
    return;
  }

  // benign handlers
  if (method === "notifications/initialized") return responder({ jsonrpc: "2.0", id, result: { ok: true } });
  if (method === "ping")                    return responder({ jsonrpc: "2.0", id, result: { ok: true } });
  if (method === "resources/list")          return responder({ jsonrpc: "2.0", id, result: { resources: [] } });
  if (method === "prompts/list")            return responder({ jsonrpc: "2.0", id, result: { prompts: [] } });

  // tools/list and aliases other clients sometimes use
  if (method === "tools/list" || method === "listTools" || method === "getTools" || method === "get_tools" || method === "list_tools") {
    return responder({ jsonrpc: "2.0", id, result: { tools: [toolSpec] } });
  }

  // tools/call
  if (method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name !== "qdrant_search") {
      return responder({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
    }
    try {
      const body = {
        query: args?.query,
        traditions: args?.traditions,
        topK: args?.topK ?? 6,
        lang: args?.lang ?? null
      };
      const r = await fetch(`${FASTAPI_URL}/query`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errTxt = await r.text();
        return responder({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `FastAPI ${r.status}: ${errTxt}` }], isError: true }
        });
      }
      const data = await r.json(); // { snippets: [...] }
      return responder({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "json", data }], isError: false }
      });
    } catch (e) {
      return responder({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: "Gateway error: " + String(e) }], isError: true }
      });
    }
  }

  // default
  responder({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

// ---------------- HTTP server (discovery, health, SSE endpoints) -------------
const clients = new Map(); // cid -> { res, alive: bool }

const server = http.createServer(async (req, res) => {
  const { pathname, query } = parse(req.url || "/", true);

  // Discovery: now advertise SSE (the Builder prefers this)
  if (pathname === "/.well-known/mcp") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const base = `${proto}://${host}`;
    const body = {
      mcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        transport: { type: "sse", url: `${base}/sse` } // <—— advertise SSE
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

  // SSE stream (server -> client). Client must pass a client id (?cid=XYZ)
  if (pathname === "/sse" && req.method === "GET") {
    const cid = (query?.cid || "").toString();
    if (!cid) { res.writeHead(400); res.end("cid required"); return; }

    log("SSE open cid:", cid);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no" // Render/proxies
    });
    res.write(`event: open\ndata: {"ok":true}\n\n`);

    clients.set(cid, { res, alive: true });

    req.on("close", () => {
      log("SSE closed cid:", cid);
      clients.delete(cid);
    });
    return;
  }

  // SSE send (client -> server). Client POSTs JSON-RPC; we respond via SSE channel above.
  if (pathname === "/sse" && req.method === "POST") {
    const cid = (query?.cid || "").toString();
    if (!cid || !clients.has(cid)) { res.writeHead(400); res.end("invalid cid"); return; }

    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", async () => {
      try {
        const msg = JSON.parse(raw);
        log("SSE ←", msg?.method);
        const stream = clients.get(cid);
        const responder = (obj) => {
          if (!stream?.alive) return;
          const payload = JSON.stringify(obj);
          stream.res.write(`event: message\ndata: ${payload}\n\n`);
          log("SSE →", obj?.result ? (obj.result?.content ? "tools/call" : "ok") : "error");
        };
        await handleRpcMessage(msg, responder);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
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
  handleProtocols: (protocols) => (Array.isArray(protocols) && protocols.includes("mcp")) ? "mcp" : (protocols?.[0] || undefined)
});

wss.on("connection", (ws, req) => {
  log("WS connected. protocol:", ws.protocol || "(none)", "ua:", req.headers["user-agent"]);
  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { log("WS bad json"); return; }
    log("WS ←", msg?.method);
    const responder = (obj) => { sendJSON(ws, obj); log("WS →", obj?.result ? (obj.result?.content ? "tools/call" : "ok") : "error"); };
    await handleRpcMessage(msg, responder);
  });
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "/", false);
  if (pathname !== "/mcp") { socket.destroy(); return; }
  log("HTTP upgrade → WS /mcp | proto:", req.headers["sec-websocket-protocol"]);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
  console.log(`HTTP :${PORT} | WS /mcp | SSE /sse | Discovery /.well-known/mcp`);
});