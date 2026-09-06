# Render MCP Gateway

Deploy this folder as a Render Web Service.

Build command:
npm install

Start command:
npm start

Environment:
AUTH_TOKEN = the same secret used by the Termux agent and ChatGPT connector.

After deploy:
https://YOUR-SERVICE.onrender.com/health

ChatGPT MCP endpoint:
https://YOUR-SERVICE.onrender.com/mcp

The Render service does not touch the project files. It only proxies MCP tool calls to the connected Termux agent over WebSocket.


## Dashboard

Open the Render service root URL in a browser. It serves a small live dashboard showing gateway health, Termux agent connection, pending requests, MCP endpoint, and the six exposed tools.
