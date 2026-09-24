// Calling a tool on another MCP server.
//
// The façade is a server to the agent and a client to everything behind it: a
// lane for the document tools, the instance's own endpoint for the static ones.
// One client per endpoint, kept for as long as the endpoint exists, because an
// initialize handshake per tool call would double the latency of every one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { fail } from "../core/errors.ts";
import type { Backend, CallResult } from "./facade.ts";

/** An MCP client per endpoint, connected on first use. */
export class SdkBackend implements Backend {
    readonly #clients = new Map<string, Promise<Client>>();

    async call(
        endpoint: string,
        tool: string,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal
    ): Promise<CallResult> {
        const client = await this.#clientFor(endpoint);

        try {
            const result = await client.callTool({ name: tool, arguments: { ...args } }, undefined, { signal });
            return {
                content: (result.content ?? []) as readonly unknown[],
                ...(result.isError === true ? { isError: true } : {}),
            };
        } catch (err) {
            // A dead endpoint should not poison the cache: the lane may be
            // replaced under us, and the next call deserves a fresh attempt.
            this.#clients.delete(endpoint);
            throw err;
        }
    }

    /** Closes every client. The façade's last act. */
    async closeAll(): Promise<void> {
        const clients = [...this.#clients.values()];
        this.#clients.clear();
        await Promise.all(clients.map(async (pending) => (await pending.catch(() => null))?.close()));
    }

    /** Drops one endpoint's client, for a lane that has gone. */
    forget(endpoint: string): void {
        this.#clients.delete(endpoint);
    }

    #clientFor(endpoint: string): Promise<Client> {
        const existing = this.#clients.get(endpoint);
        if (existing !== undefined) return existing;

        const connecting = (async () => {
            const client = new Client({ name: "mcp-headless", version: "0.0.0" });
            try {
                await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
            } catch (err) {
                fail("unreachable", `cannot reach the MCP endpoint at ${endpoint}: ${reasonOf(err)}`, { endpoint });
            }
            return client;
        })();

        this.#clients.set(endpoint, connecting);
        connecting.catch(() => this.#clients.delete(endpoint));
        return connecting;
    }
}

function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
