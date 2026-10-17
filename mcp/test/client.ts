// Drives gendo-mcp through the official MCP client, as an agent host would.
//   tsx mcp/test/client.ts <allowance-unit> <signer-socket> <payee-addr> <stranger-addr>
// Env: VAULT_HOME (the agent's joined home), VAULT_NETWORK, devnet URLs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [unit, socket, payee, stranger] = process.argv.slice(2) as [string, string, string, string];
const ROOT = join(import.meta.dirname, "../..");
const ok = (m: string) => console.log(`  ok  ${m}`);
const fail = (m: string): never => {
  console.log(`  FAIL ${m}`);
  process.exit(1);
};

const client = new Client({ name: "gendo-test", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: join(ROOT, "mcp/gendo-mcp"),
    args: ["--allowance", unit, "--signer-socket", socket],
    env: process.env as Record<string, string>,
    stderr: "inherit", // the server's log, kept apart from the protocol on stdout
  }),
);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as { text: string }[])[0]!.text);
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
if (JSON.stringify(tools) !== JSON.stringify(["get_budget", "order_status", "pay", "request_approval", "swap"])) fail(`tools ${tools}`);
ok("five tools (budget, pay, approval, swap, order status), none of them an owner operation");

const b0 = await call("get_budget");
const ada = b0.limits.find((l: { asset: string }) => l.asset === "ADA");
if (ada.per_payment !== 10 || ada.per_period !== 20 || b0.paused || !b0.approved_payees.includes(payee)) fail(JSON.stringify(b0));
ok("get_budget: 10 ADA per payment, 20 per period, payee approved");

const p1 = await call("pay", { to: payee, amount_ada: 3, intent_id: "MCP-1", purpose: "hosting" });
if (p1.status !== "paid") fail(`pay: ${JSON.stringify(p1)}`);
ok(`pay 3 ADA: paid in ${p1.tx.slice(0, 12)}…`);

const p1b = await call("pay", { to: payee, amount_ada: 3, intent_id: "MCP-1", purpose: "hosting" });
if (p1b.status !== "already_paid" || p1b.tx !== p1.tx) fail(`retry: ${JSON.stringify(p1b)}`);
ok("same intent_id again: already_paid, nothing sent");

const p2 = await call("pay", { to: payee, amount_ada: 12, intent_id: "MCP-2", purpose: "license" });
if (p2.status !== "blocked" || p2.code !== "TX_CAP" || !/request_approval/.test(p2.next_step)) fail(`over cap: ${JSON.stringify(p2)}`);
ok("12 ADA: blocked TX_CAP, told to request approval");

const p3 = await call("pay", { to: stranger, amount_ada: 1, intent_id: "MCP-3", purpose: "consulting" });
if (p3.status !== "blocked" || p3.code !== "DESTINATION") fail(`stranger: ${JSON.stringify(p3)}`);
ok("unapproved payee: blocked DESTINATION");

const b1 = await call("get_budget");
const spent = b1.limits.find((l: { asset: string }) => l.asset === "ADA").spent_this_period;
if (!(spent > 3 && spent < 4)) fail(`spent ${spent}`);
ok(`get_budget after paying: ${spent} ADA spent this period (3 + fee)`);

const a = await call("request_approval", { to: payee, amount_ada: 12, intent_id: "MCP-2", purpose: "license", reason: "annual license" });
if (a.status !== "awaiting_owners" || !existsSync(a.file) || !a.expires_at) fail(`approval: ${JSON.stringify(a)}`);
ok(`request_approval: file for the owners, valid until ${a.expires_at}`);
console.log(`FILE ${a.file}`);
await client.close();
