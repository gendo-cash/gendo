// Before the budget lands, every tool answers "not ready" with the reason instead of failing.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";

describe("tools before ready", () => {
  it("pay and get_budget answer not_ready with the connection message", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, async () => ({ notReady: "Paired as blue-otter-42; waiting for a budget." }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const [name, args] of [["pay", { to: "addr_test1x", amount_ada: 1, intent_id: "I", purpose: "p" }], ["get_budget", {}]] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: "not_ready", message: "Paired as blue-otter-42; waiting for a budget." });
    }
  });
  it("hands each result to the caller's hook (gendo-agent reconnects when its token stopped working)", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const seen: unknown[] = [];
    registerTools(server, async () => ({ notReady: "x" }), (r) => seen.push(r));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "get_budget", arguments: {} });
    expect(seen).toEqual([{ status: "not_ready", message: "x" }]);
  });
  it("adds the agent's notice (an update) to every result", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, async () => ({ notReady: "x" }), undefined, () => "An update to gendo 9.0.0 is available.");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "get_budget", arguments: {} });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: "not_ready", message: "x", notice: "An update to gendo 9.0.0 is available." });
  });
  it("offers swap and order_status next to the payment tools", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, async () => ({ notReady: "x" }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_budget", "order_status", "pay", "request_approval", "swap"]);
    const r = await client.callTool({ name: "swap", arguments: { app: "minswap", pool: "ADA ↔ NACRE", amount_ada: 1, intent_id: "I", purpose: "p" } });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: "not_ready", message: "x" });
  });
});
