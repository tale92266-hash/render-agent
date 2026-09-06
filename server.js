import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("FATAL: AUTH_TOKEN is missing");
  process.exit(1);
}

let agent = null;
const pending = new Map();

function authorized(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${AUTH_TOKEN}`;
}

function requireAuth(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireAgent() {
  if (!agent || agent.readyState !== 1) {
    throw new Error("Termux agent is offline. Start the Termux agent first.");
  }
  return agent;
}

function callTermux(tool, args) {
  const ws = requireAgent();
  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Termux tool timed out: ${tool}`));
    }, Number(process.env.TOOL_TIMEOUT_MS || 60000));

    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); pending.delete(id); resolve(value); },
      reject: (err) => { clearTimeout(timer); pending.delete(id); reject(err); }
    });

    ws.send(JSON.stringify({
      type: "tool_request",
      id,
      tool,
      args: args || {}
    }));
  });
}

function makeMcpServer() {
  const server = new McpServer({
    name: "termux-project-mcp",
    version: "1.0.0"
  });

  const proxy = (tool, description, inputSchema) =>
    server.registerTool(tool, { description, inputSchema }, async (args) => {
      const result = await callTermux(tool, args);
      return result;
    });

  proxy(
    "list_files",
    "List files and directories inside the selected Termux project.",
    { dirPath: z.string().optional().describe("Relative directory path") }
  );

  proxy(
    "read_file",
    "Read a text file from the selected Termux project.",
    { filePath: z.string().describe("Relative file path") }
  );

  proxy(
    "write_file",
    "Create or overwrite a file in the selected Termux project.",
    {
      filePath: z.string().describe("Relative file path"),
      content: z.string().describe("Complete file content")
    }
  );

  proxy(
    "create_folder",
    "Create a folder in the selected Termux project.",
    { folderPath: z.string().describe("Relative folder path") }
  );

  proxy(
    "delete_file",
    "Delete a file or folder in the selected Termux project.",
    { filePath: z.string().describe("Relative file or folder path") }
  );

  proxy(
    "run_command",
    "Run a shell command inside the selected Termux project directory.",
    { command: z.string().describe("Shell command to execute") }
  );

  return server;
}

app.get("/", (req, res) => {
  res.json({
    name: "termux-render-mcp-gateway",
    status: "ok",
    agent: !!agent && agent.readyState === 1,
    mcp: "/mcp",
    agentEndpoint: "/agent"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    agentConnected: !!agent && agent.readyState === 1,
    pendingRequests: pending.size
  });
});

app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = makeMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get("/mcp", requireAuth, (req, res) => {
  res.status(405).json({ error: "Use POST /mcp" });
});

app.delete("/mcp", requireAuth, (req, res) => {
  res.status(405).json({ error: "Stateless MCP endpoint" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render MCP Gateway listening on ${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== "/agent") {
    socket.destroy();
    return;
  }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  if (agent && agent.readyState === 1) {
    agent.close(4000, "Replaced by a newer Termux agent");
  }

  agent = ws;
  console.log("Termux agent connected");

  ws.send(JSON.stringify({
    type: "hello",
    message: "Connected to Render MCP gateway"
  }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "tool_response" && msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;

        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }

      if (msg.type === "status") {
        console.log("Termux:", msg.status || "unknown");
      }
    } catch (err) {
      console.error("Invalid agent message:", err.message);
    }
  });

  ws.on("close", () => {
    if (agent === ws) agent = null;
    console.log("Termux agent disconnected");

    for (const [id, p] of pending) {
      p.reject(new Error("Termux agent disconnected"));
      pending.delete(id);
    }
  });

  ws.on("error", (err) => {
    console.error("Agent websocket error:", err.message);
  });
});

process.on("SIGTERM", () => {
  for (const [, p] of pending) p.reject(new Error("Gateway shutting down"));
  server.close(() => process.exit(0));
});
