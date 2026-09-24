// Acceptance test for the headless host: drive the MCP server as a real client.
// Requires: MCP server on 4401, host.js running.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.PENPOT_MCP_URL ?? "http://localhost:4401/mcp";
const client = new Client({ name: "headless-host-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

const run = async (label, code) => {
    const r = await client.callTool({ name: "execute_code", arguments: { code } });
    console.log(
        `\n--- ${label}\n${r.content
            .map((c) => c.text ?? `[${c.type}]`)
            .join("\n")
            .slice(0, 600)}`
    );
    return r;
};

await run(
    "read: what file are we in?",
    `return { file: penpot.currentFile?.name, page: penpot.currentPage?.name, shapes: penpot.currentPage?.children?.length };`
);

await run(
    "write: create a rectangle",
    `const r = penpot.createRectangle();
     r.name = "mcp-headless-smoke";
     r.x = 40; r.y = 40; r.resize(160, 90);
     r.fills = [{ fillColor: "#7C3AED", fillOpacity: 1 }];
     return { id: r.id, name: r.name, x: r.x, y: r.y };`
);

await run("read back: shape names on page", `return penpot.currentPage.findShapes().map((s) => s.name);`);

await client.close();
process.exit(0);
