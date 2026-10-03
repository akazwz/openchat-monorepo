#!/bin/bash
# The browser's MCP server (docs/sandbox.md): Playwright MCP over HTTP on
# port 8931, driving the screen's browser (heveta-browser) through its
# DevTools port, so the agent works in the window the person watches. Only
# the Worker reaches it, through the sandbox, which connects from outside the
# container: it listens on every interface, as the screen's websockify does
# (on 127.0.0.1 only, it was out of reach in Cloudflare's containers, and
# answered only in local development, whose container shares its proxy's
# network). The container takes no connection from anywhere else, and the
# server still serves only requests addressed to localhost:8931 (the Host
# it compares has the port). Relative names resolve against its working
# directory (the client declares no MCP roots), so files saved by name land
# in the workspace; its own files (page snapshots of actions, unnamed
# screenshots) go to /tmp. Results name files by absolute path, which
# read_file takes as is, and leave out the Playwright code of each step.
# Running it again only makes sure both are up.
set -euo pipefail
port=8931
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; }

heveta-browser
if listening; then exit 0; fi
cd /workspace
setsid -f playwright-mcp --cdp-endpoint http://127.0.0.1:9222 \
  --host 0.0.0.0 --allowed-hosts "localhost:$port" --port "$port" \
  --output-dir /tmp/playwright-mcp \
  --file-paths absolute --codegen none \
  >/tmp/browser-mcp.log 2>&1 </dev/null
for _ in $(seq 100); do
  if listening; then exit 0; fi
  sleep 0.1
done
echo "The browser's MCP server did not start" >&2
exit 1
