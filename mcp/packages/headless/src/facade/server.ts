// The transport shell: MCP over Streamable HTTP, and nothing else.
//
// Stateful, matching the choice Penpot's own server made -- sessions carry the
// document a client is connected to. The protocol has permitted both since
// Streamable HTTP replaced HTTP+SSE, so this inherits nothing by matching it.
//
// Every rule lives in `facade.ts`. This file reads requests, finds the session,
// and calls that; if a decision appears here it is in the wrong place.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { isLauncherError } from "../core/errors.ts";
import { isLoopback, type Address } from "./address.ts";
import { DOCUMENT_TOOLS, STATIC_TOOLS, type DocumentTool, type Facade, type StaticTool } from "./facade.ts";

/** The path the agent's configuration points at. */
const PATH = "/mcp";

/** Largest request body accepted, which is generous for code and small images. */
const MAX_BODY = 32 * 1024 * 1024;

/** A running façade, and the way to stop it. */
export interface Serving {
    readonly address: Address;
    close(): Promise<void>;
}

export interface ServeOptions {
    readonly facade: Facade;
    readonly address: Address;
    /** Where startup and bind messages go. */
    readonly log: (line: string) => void;
}

/**
 * The document argument every document-scoped tool gains.
 *
 * Optional, so a connected session need not repeat itself, and present at all
 * because a session can be swept or a client can reconnect -- at which point
 * naming the document is the only way back without the agent noticing.
 */
const DOCUMENT_ARG = {
    document: {
        type: "string",
        description:
            "Which document to act on, by name or file id. Optional once connect_doc has been called; " +
            "giving it switches this session to that document.",
    },
} as const;

/** The tools the façade advertises, hand-written because there is no lane to ask at startup. */
function toolDefinitions(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return [
        {
            name: "list_documents",
            description: "Lists the Penpot documents this worker account can drive, as 'team / document'.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
            name: "connect_doc",
            description:
                "Connects this session to a document, opening a browser lane for it if one is not already " +
                "warm. Blocks until the document is ready to drive. A session holds one document at a time, " +
                "so connecting to another releases the first. Reports anyone else editing the same file.",
            inputSchema: {
                type: "object",
                properties: {
                    document: { type: "string", description: "Document name or file id; a unique fragment works." },
                },
                required: ["document"],
                additionalProperties: false,
            },
        },
        {
            name: "disconnect_doc",
            description: "Releases the document this session holds, so another client may take it.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
            name: "execute_code",
            description:
                "Runs JavaScript in the Penpot plugin sandbox of the connected document. The penpot API, " +
                "penpotUtils, console and a persistent `storage` object are in scope.",
            inputSchema: {
                type: "object",
                properties: { code: { type: "string" }, ...DOCUMENT_ARG },
                required: ["code"],
                additionalProperties: false,
            },
        },
        {
            name: "export_shape",
            description: "Exports a shape of the connected document to a file.",
            inputSchema: {
                type: "object",
                properties: {
                    shapeId: { type: "string" },
                    format: { type: "string" },
                    mode: { type: "string" },
                    filePath: { type: "string" },
                    ...DOCUMENT_ARG,
                },
                required: ["shapeId"],
                additionalProperties: false,
            },
        },
        {
            name: "import_image",
            description: "Imports an image file into the connected document.",
            inputSchema: {
                type: "object",
                properties: {
                    filePath: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    ...DOCUMENT_ARG,
                },
                required: ["filePath"],
                additionalProperties: false,
            },
        },
        {
            name: "high_level_overview",
            description: "Penpot's high-level overview. Read this first; it needs no connected document.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
            name: "penpot_api_info",
            description: "Details of the Penpot plugin API. Needs no connected document.",
            inputSchema: {
                type: "object",
                properties: { type: { type: "string" }, member: { type: "string" } },
                additionalProperties: false,
            },
        },
    ];
}

/** Starts the façade on `address`, and resolves once it is listening. */
export async function serveFacade(options: ServeOptions): Promise<Serving> {
    const { facade, address, log } = options;
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const build = (): McpServer => {
        const server = new McpServer({ name: "mcp-headless", version: "0.0.0" }, { capabilities: { tools: {} } });

        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));

        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const name = request.params.name;
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;
            // Every rule is keyed by the session; a request without one is a
            // protocol violation the SDK should have caught.
            const sessionId = extra.sessionId ?? "anonymous";
            const signal = extra.signal ?? AbortSignal.timeout(600_000);

            try {
                return await dispatch(facade, sessionId, name, args, signal);
            } catch (err) {
                // A refusal is an answer, not a transport failure: the agent
                // should read it and do something else.
                return { content: [{ type: "text", text: reasonOf(err) }], isError: true };
            }
        });

        return server;
    };

    const http = createServer((req, res) => {
        void handle(req, res, sessions, build, facade).catch((err: unknown) => {
            log(`request failed: ${reasonOf(err)}`);
            if (!res.headersSent) res.writeHead(500).end();
        });
    });

    await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(address.port, address.host, () => {
            http.removeListener("error", reject);
            resolve();
        });
    });

    log(`mcp endpoint  http://${address.host}:${address.port}${PATH}`);
    if (!isLoopback(address.host)) {
        log(`WARNING: listening on ${address.host}, which is reachable beyond this machine. There is no auth.`);
    }

    return {
        address,
        close: async () => {
            for (const transport of sessions.values()) await transport.close().catch(() => undefined);
            sessions.clear();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

/** Routes one tool call to the façade. */
async function dispatch(
    facade: Facade,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
): Promise<{ content: unknown[]; isError?: boolean }> {
    if (name === "list_documents") {
        const listed = await facade.listDocuments(signal);
        return { content: [{ type: "text", text: JSON.stringify(listed, null, 2) }] };
    }
    if (name === "connect_doc") {
        const connected = await facade.connectDoc(sessionId, String(args.document ?? ""), signal);
        return { content: [{ type: "text", text: JSON.stringify(connected, null, 2) }] };
    }
    if (name === "disconnect_doc") {
        const released = await facade.disconnectDoc(sessionId);
        return { content: [{ type: "text", text: JSON.stringify(released) }] };
    }
    if ((STATIC_TOOLS as readonly string[]).includes(name)) {
        const result = await facade.callStatic(name as StaticTool, args, signal);
        return { content: [...result.content], ...(result.isError === true ? { isError: true } : {}) };
    }
    if ((DOCUMENT_TOOLS as readonly string[]).includes(name)) {
        const result = await facade.callDocument(sessionId, name as DocumentTool, args, signal);
        return { content: [...result.content], ...(result.isError === true ? { isError: true } : {}) };
    }

    return { content: [{ type: "text", text: `there is no tool called ${name}` }], isError: true };
}

/** One HTTP request: find or make the session, then let the SDK have it. */
async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    sessions: Map<string, StreamableHTTPServerTransport>,
    build: () => McpServer,
    facade: Facade
): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== PATH) {
        res.writeHead(404).end();
        return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    const body = req.method === "POST" ? await readBody(req) : undefined;

    if (existing !== undefined) {
        await existing.handleRequest(req, res, body);
        return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
            sessions.set(id, transport);
        },
    });

    // A client that goes away must not keep a document from everyone else.
    transport.onclose = () => {
        const id = transport.sessionId;
        if (id === undefined) return;
        sessions.delete(id);
        void facade.releaseSession(id);
    };

    await build().connect(transport);
    await transport.handleRequest(req, res, body);
}

/** Reads and parses a JSON body, refusing one that is absurdly large. */
async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new Error(`request body larger than ${MAX_BODY} bytes`);
        chunks.push(chunk as Buffer);
    }

    const text = Buffer.concat(chunks).toString("utf8");
    return text.trim() === "" ? undefined : JSON.parse(text);
}

function reasonOf(err: unknown): string {
    if (isLauncherError(err)) return err.message;
    return err instanceof Error ? err.message : String(err);
}
