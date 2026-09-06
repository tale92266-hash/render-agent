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
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("FATAL: AUTH_TOKEN is missing");
  process.exit(1);
}

let agent = null;
const pending = new Map();


// ============================================================
// AUTHENTICATION
// Supports:
//   1. Authorization: Bearer <token>
//   2. /mcp?token=<token>
// ============================================================

function authorized(req) {
  const h = req.headers.authorization || "";
  const queryToken = req.query?.token || "";

  return (
    h === `Bearer ${AUTH_TOKEN}` ||
    queryToken === AUTH_TOKEN
  );
}

function requireAuth(req, res, next) {
  if (!authorized(req)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}


// ============================================================
// TERMUX AGENT
// ============================================================

function requireAgent() {
  if (!agent || agent.readyState !== 1) {
    throw new Error(
      "Termux agent is offline. Start the Termux agent first."
    );
  }

  return agent;
}


// ============================================================
// CALL TERMUX TOOL
// ============================================================

function callTermux(tool, args) {
  const ws = requireAgent();
  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(`Termux tool timed out: ${tool}`)
      );
    }, Number(process.env.TOOL_TIMEOUT_MS || 60000));

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      },

      reject: (err) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });

    ws.send(
      JSON.stringify({
        type: "tool_request",
        id,
        tool,
        args: args || {}
      })
    );
  });
}


// ============================================================
// MCP SERVER
// ============================================================

function makeMcpServer() {
  const server = new McpServer({
    name: "termux-project-mcp",
    version: "1.0.0"
  });

  const proxy = (
    tool,
    description,
    inputSchema
  ) =>
    server.registerTool(
      tool,
      {
        description,
        inputSchema
      },
      async (args) => {
        const result = await callTermux(tool, args);
        return result;
      }
    );


  // ----------------------------------------------------------
  // LIST FILES
  // ----------------------------------------------------------

  proxy(
    "list_files",
    "List files and directories inside the selected Termux project.",
    {
      dirPath: z
        .string()
        .optional()
        .describe("Relative directory path")
    }
  );


  // ----------------------------------------------------------
  // READ FILE
  // ----------------------------------------------------------

  proxy(
    "read_file",
    "Read a text file from the selected Termux project.",
    {
      filePath: z
        .string()
        .describe("Relative file path")
    }
  );


  // ----------------------------------------------------------
  // WRITE FILE
  // ----------------------------------------------------------

  proxy(
    "write_file",
    "Create or overwrite a file in the selected Termux project.",
    {
      filePath: z
        .string()
        .describe("Relative file path"),

      content: z
        .string()
        .describe("Complete file content")
    }
  );


  // ----------------------------------------------------------
  // CREATE FOLDER
  // ----------------------------------------------------------

  proxy(
    "create_folder",
    "Create a folder in the selected Termux project.",
    {
      folderPath: z
        .string()
        .describe("Relative folder path")
    }
  );


  // ----------------------------------------------------------
  // DELETE FILE
  // ----------------------------------------------------------

  proxy(
    "delete_file",
    "Delete a file or folder in the selected Termux project.",
    {
      filePath: z
        .string()
        .describe("Relative file or folder path")
    }
  );


  // ----------------------------------------------------------
  // RUN COMMAND
  // ----------------------------------------------------------

  proxy(
    "run_command",
    "Run a shell command inside the selected Termux project directory.",
    {
      command: z
        .string()
        .describe("Shell command to execute")
    }
  );


  return server;
}


// ============================================================
// FRONTEND
// ============================================================

app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: "public"
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    agentConnected:
      !!agent && agent.readyState === 1,
    pendingRequests: pending.size
  });
});


// ============================================================
// MCP ENDPOINT
// ============================================================
//
// Authentication supports:
//
//   Authorization: Bearer TOKEN
//
// OR:
//
//   /mcp?token=TOKEN
//
// ============================================================

app.post(
  "/mcp",
  requireAuth,
  async (req, res) => {
    try {
      const server = makeMcpServer();

      const transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });

      await server.connect(transport);

      await transport.handleRequest(
        req,
        res,
        req.body
      );
    } catch (err) {
      console.error(
        "MCP error:",
        err
      );

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message
        });
      }
    }
  }
);


// ============================================================
// MCP GET
// ============================================================

app.get(
  "/mcp",
  requireAuth,
  (req, res) => {
    res.status(405).json({
      error: "Use POST /mcp"
    });
  }
);


// ============================================================
// MCP DELETE
// ============================================================

app.delete(
  "/mcp",
  requireAuth,
  (req, res) => {
    res.status(405).json({
      error: "Stateless MCP endpoint"
    });
  }
);


// ============================================================
// HTTP SERVER
// ============================================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Render MCP Gateway listening on ${PORT}`
    );
  }
);


// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocketServer({
  noServer: true
});


// ============================================================
// WEBSOCKET UPGRADE
// ============================================================

server.on(
  "upgrade",
  (req, socket, head) => {
    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );


    // Only /agent is allowed
    if (url.pathname !== "/agent") {
      socket.destroy();
      return;
    }


    // --------------------------------------------------------
    // Termux agent authentication
    // --------------------------------------------------------

    const auth =
      req.headers.authorization || "";

    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n\r\n"
      );

      socket.destroy();
      return;
    }


    wss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => {
        wss.emit(
          "connection",
          ws,
          req
        );
      }
    );
  }
);


// ============================================================
// AGENT CONNECTION
// ============================================================

wss.on(
  "connection",
  (ws) => {

    // Replace previous agent
    if (
      agent &&
      agent.readyState === 1
    ) {
      agent.close(
        4000,
        "Replaced by a newer Termux agent"
      );
    }


    agent = ws;

    console.log(
      "Termux agent connected"
    );


    // --------------------------------------------------------
    // Welcome message
    // --------------------------------------------------------

    ws.send(
      JSON.stringify({
        type: "hello",
        message:
          "Connected to Render MCP gateway"
      })
    );


    // --------------------------------------------------------
    // Messages from Termux
    // --------------------------------------------------------

    ws.on(
      "message",
      (raw) => {
        try {
          const msg =
            JSON.parse(
              raw.toString()
            );


          // --------------------------------------------------
          // Tool response
          // --------------------------------------------------

          if (
            msg.type ===
              "tool_response" &&
            msg.id
          ) {
            const p =
              pending.get(msg.id);

            if (!p) {
              return;
            }


            if (msg.error) {
              p.reject(
                new Error(
                  msg.error
                )
              );
            } else {
              p.resolve(
                msg.result
              );
            }

            return;
          }


          // --------------------------------------------------
          // Status message
          // --------------------------------------------------

          if (
            msg.type === "status"
          ) {
            console.log(
              "Termux:",
              msg.status ||
                "unknown"
            );
          }

        } catch (err) {
          console.error(
            "Invalid agent message:",
            err.message
          );
        }
      }
    );


    // --------------------------------------------------------
    // Agent disconnected
    // --------------------------------------------------------

    ws.on(
      "close",
      () => {

        if (agent === ws) {
          agent = null;
        }

        console.log(
          "Termux agent disconnected"
        );


        for (
          const [id, p]
          of pending
        ) {
          p.reject(
            new Error(
              "Termux agent disconnected"
            )
          );

          pending.delete(id);
        }
      }
    );


    // --------------------------------------------------------
    // WebSocket error
    // --------------------------------------------------------

    ws.on(
      "error",
      (err) => {
        console.error(
          "Agent websocket error:",
          err.message
        );
      }
    );
  }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on(
  "SIGTERM",
  () => {

    for (
      const [, p]
      of pending
    ) {
      p.reject(
        new Error(
          "Gateway shutting down"
        )
      );
    }

    server.close(
      () => process.exit(0)
    );
  }
);
