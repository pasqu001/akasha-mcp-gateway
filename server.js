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

// IMPORTANT: snake_case per MCP spec
const toolSpec = {
  name: "qdrant_search",
  description:
    "Embed + search via Akasha FastAPI /query. Args: query, traditions (string|array), topK, lang.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      traditions: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
      },
      topK: { type: "number", default: 6 },
      lang: { type: "string" }
    },
    required: ["query", "traditions"]
  }
};

// ---------- HTTP (discovery & health) ----------
const server = http.createServer((req, res) => {
  const { pathname } = parse(req.url || "/", false);

  if (pathname === "/.well-known/mcp") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const wsProto = proto === "https" ? "wss" : "ws";
    const mcpUrl = `${wsProto}://${host}/mcp`;
    const body = { mcp: { name: SERVER_NAME, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, transport: { type: "websocket", url: mcpUrl } } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, docs: "/.well-known/mcp", ws: "/mcp", fastapi: FASTAPI_URL }));
    return;
  }

  res.writeHead(404); res.end();
});

// ---------- WebSocket MCP ----------
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (Array.isArray(protocols) && protocols.includes("mcp")) return "mcp";
    return protocols?.[0] || undefined;
  }
});

function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function log(...args) { console.log("[MCP]", ...args); }

wss.on("connection", (ws, req) => {
  log("WS connected. protocol:", ws.protocol || "(none)", "ua:", req.headers["user-agent"]);

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { log("Non-JSON message ignored"); return; }
    const { id, method } = msg;
    log("←", method || "(no method)");

    if (method === "initialize") {
      send(ws, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} }   // explicit tools capability
        }
      });
      log("→ initialize/ok");
      return;
    }

    // benign handlers
    if (method === "notifications/initialized") { log("notif initialized"); return; }
    if (method === "ping") { send(ws, { jsonrpc: "2.0", id, result: { ok: true } }); return; }
    if (method === "resources/list") { send(ws, { jsonrpc: "2.0", id, result: { resources: [] } }); return; }
    if (method === "prompts/list") { send(ws, { jsonrpc: "2.0", id, result: { prompts: [] } }); return; }

    // tools/list (support alt spellings)
    if (method === "tools/list" || method === "listTools" || method === "getTools") {
      send(ws, { jsonrpc: "2.0", id, result: { tools: [toolSpec] } });
      log("→ tools/list (1 tool)", JSON.stringify(toolSpec));
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = msg.params || {};
      if (name !== "qdrant_search") {
        send(ws, { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
        log("→ tools/call unknown tool");
        return;
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
          send(ws, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `FastAPI ${r.status}: ${errTxt}` }], isError: true } });
          log("→ tools/call FastAPI error", r.status);
          return;
        }

        const data = await r.json(); // { snippets: [...] }
        send(ws, { jsonrpc: "2.0", id, result: { content: [{ type: "json", data }], isError: false } });
        log("→ tools/call ok");
      } catch (e) {
        send(ws, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Gateway error: " + String(e) }], isError: true } });
        log("→ tools/call exception", e);
      }
      return;
    }

    send(ws, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    log("→ method not found", method);
  });
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "/", false);
  if (pathname !== "/mcp") { socket.destroy(); return; }
  log("HTTP upgrade → WS /mcp | proto:", req.headers["sec-websocket-protocol"]);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
  console.log(`HTTP :${PORT}  |  WS /mcp  |  Discovery /.well-known/mcp`);
});