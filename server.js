import { WebSocketServer } from "ws";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;
const FASTAPI_URL = process.env.FASTAPI_URL; // e.g., https://ash-mcp-server-app.onrender.com
if (!FASTAPI_URL) {
  console.error("FASTAPI_URL env var is required");
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT, path: "/mcp" });
console.log(`MCP (lite) gateway listening at ws://0.0.0.0:${PORT}/mcp`);

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

// Minimal MCP-ish JSON-RPC
wss.on("connection", (ws) => {
  ws.on("message", async (buf) => {
    let req;
    try { req = JSON.parse(buf.toString()); } catch { return; }

    // 1) Handshake
    if (req.method === "initialize") {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2024-05-14", capabilities: {} }
      }));
      return;
    }

    // 2) List tools
    if (req.method === "tools/list") {
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: req.id, result: { tools: [toolSpec] }
      }));
      return;
    }

    // 3) Call tool
    if (req.method === "tools/call") {
      const { name, arguments: args } = req.params || {};
      if (name !== "qdrant_search") {
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          error: { code: -32601, message: "Unknown tool" }
        }));
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

        const data = await r.json(); // { snippets: [...] }
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "json", data }],
            isError: false
          }
        }));
      } catch (e) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "text", text: "Gateway error: " + String(e) }],
            isError: true
          }
        }));
      }
      return;
    }

    // Default
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "Method not found" }
    }));
  });
});