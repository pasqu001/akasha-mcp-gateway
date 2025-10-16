// server.js
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { parse } from "url";

const PORT = process.env.PORT || 8080;
const FASTAPI_URL = process.env.FASTAPI_URL; // e.g., https://ash-mcp-server-app.onrender.com
if (!FASTAPI_URL) {
  console.error("FASTAPI_URL env var is required");
  process.exit(1);
}

const PROTOCOL_VERSION = "2024-05-14";
const SERVER_NAME = "akasha-mcp";
const SERVER_VERSION = "0.1.0";

const toolSpec = {
  name: "qdrant_search",
  description:
    "Embed + search via Akasha FastAPI /query. Args: query, traditions (string|array), topK, lang.",
  inputSchema: {
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

// --- HTTP server for discovery & health ---
const server = http.createServer((req, res) => {
  const { pathname } = parse(req.url || "/", false);

  if (pathname === "/.well-known/mcp") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const wsProto = proto === "https" ? "wss" : "ws";
    const mcpUrl = `${wsProto}://${host}/mcp`;

    const body = {
      mcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        transport: { type: "websocket", url: mcpUrl }
      }
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        docs: "/.well-known/mcp",
        ws: "/mcp",
        fastapi: FASTAPI_URL
      })
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

// --- WebSocket MCP gateway (accept subprotocol 'mcp') ---
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols /*, request */) => {
    if (Array.isArray(protocols) && protocols.includes("mcp")) return "mcp";
    return protocols?.[0] || undefined; // accept even if none provided
  }
});

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  console.log("WS connection established. Protocol:", ws.protocol || "(none)");

  ws.on("message", async (buf) => {
    let reqMsg;
    try {
      reqMsg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const id = reqMsg.id;

    // 1) MCP handshake
    if (reqMsg.method === "initialize") {
      send(ws, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} }
        }
      });
      return;
    }

    // Optional no-ops some clients call
    if (reqMsg.method === "ping") {
      send(ws, { jsonrpc: "2.0", id, result: { ok: true } });
      return;
    }
    if (reqMsg.method === "resources/list") {
      send(ws, { jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }
    if (reqMsg.method === "prompts/list") {
      send(ws, { jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }

    // 2) List tools
    if (reqMsg.method === "tools/list") {
      send(ws, { jsonrpc: "2.0", id, result: { tools: [toolSpec] } });
      return;
    }

    // 3) Call tool
    if (reqMsg.method === "tools/call") {
      const { name, arguments: args } = reqMsg.params || {};
      if (name !== "qdrant_search") {
        send(ws, { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
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
          send(ws, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `FastAPI ${r.status}: ${errTxt}` }],
              isError: true
            }
          });
          return;
        }

        const data = await r.json(); // { snippets: [...] }
        send(ws, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "json", data }], isError: false }
        });
      } catch (e) {
        send(ws, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "Gateway error: " + String(e) }], isError: true }
        });
      }
      return;
    }

    // Default
    send(ws, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  });
});

// Upgrade HTTP → WS only for /mcp
server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "/", false);
  if (pathname !== "/mcp") {
    socket.destroy();
    return;
  }
  console.log("HTTP upgrade → WS /mcp. Protocol header:", req.headers["sec-websocket-protocol"]);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
  console.log(`HTTP :${PORT}  |  WS /mcp  |  Discovery /.well-known/mcp`);
});