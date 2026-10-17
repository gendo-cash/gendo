// app/test/agent-e2e.mjs: connect an agent with no terminal, on the devnet. Owner A makes a pairing code
// in the app; gendo-agent starts the way an AI app starts it (stdio MCP) and claims it; A checks the words
// and proposes the budget; B signs; the agent becomes ready and pays through its MCP tool.
// Env: APP, POLICY, KEY_A, KEY_B, PAYEE (an approved payee address), AGENT_MAIN (gendo-agent/dist/main.mjs).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { browser } from "./driver.mjs";

const { APP, POLICY, KEY_A, KEY_B, PAYEE, AGENT_MAIN } = process.env;
const ok = (m) => console.log(`  ok  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await browser(9351);
const B = await browser(9352);
let client;
const signIn = async (b, key) => {
  await b.open(`${APP}/vaults?testwallet=${key}`);
  await b.click(/Test wallet\s+Detected/);
  await b.waitText(/All vaults/);
};
const tool = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const until = async (name, want, ms) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await tool(name);
    if (last.status === want) return last;
    await sleep(2000);
  }
  throw new Error(`connection_status never became ${want}: ${JSON.stringify(last)}`);
};
try {
  await signIn(A, KEY_A);
  await signIn(B, KEY_B);

  // Owner A enables Minswap on the vault (every rule typed: no defaults); owner B signs.
  await A.open(`${APP}/v/${POLICY}/apps`);
  await A.click(/^Enable Minswap$/);
  await A.check(/ADA ↔ TEST/);
  for (const [id, v] of [["ms-slippage", "3"], ["ms-fee", "2"], ["ms-hours", "24"], ["ms-tip", "0.5"]]) await A.fill(id, v);
  await A.click(/^Review and propose$/);
  await A.waitText(/Review before signing[\s\S]*Enable Minswap[\s\S]*Minswap max slippage/);
  // The settings record grows, so it holds a little more ADA (from the proposer): the review warns, and A confirms.
  await A.click(/^I've read the warnings$/, 3_000).catch(() => undefined);
  await A.click(/^Sign with wallet$/);
  await B.open(`${APP}/`);
  await B.waitText(/Enable Minswap/);
  await B.click(/^Sign with wallet$/);
  for (let i = 0; i < 40; i++) {
    await A.open(`${APP}/v/${POLICY}/apps`);
    if (/Change settings/.test(await A.waitText(/Minswap/))) break;
    await sleep(3000);
  }
  await A.waitText(/Change settings/);
  ok("owner A enabled Minswap in the app (pools, 3% slippage, fee, lifetime, tip), owner B signed, it landed");

  await A.open(`${APP}/v/${POLICY}/connect`);
  await A.waitText(/Name this agent/); // the vault list loads first
  await A.fill("pname", "My Claude");
  await A.click(/^Get a pairing code$/);
  const code = (await A.waitText(/GENDO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)).match(/GENDO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)[0];
  ok(`owner A got a pairing code (${code}) with install options`);

  client = new Client({ name: "e2e-host", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [AGENT_MAIN, "--pair", code, "--server", APP, "--home", mkdtempSync(join(tmpdir(), "gendo-agent-e2e-"))], stderr: "inherit" }));
  const { words } = await until("connection_status", "claimed", 60_000);
  ok(`gendo-agent started like an AI app starts it, made its key and claimed the code: ${words}`);

  await A.waitText(new RegExp(`Your agent says:[\\s\\S]*${words}`));
  await A.click(/^They match$/);
  await A.waitText(/Agent\s+My Claude/);
  await A.fill("newPayee", PAYEE);
  await A.click(/^Add$/);
  await A.check(/Minswap: swap within this budget/);
  await A.click(/^Propose agent$/);
  await A.waitText(/Review before signing[\s\S]*Collateral for the agent/);
  await A.click(/^I've read the warnings$/, 3_000).catch(() => undefined);
  await A.click(/^Sign with wallet$/);
  await A.waitText(/My Claude connects once it lands/);
  await B.open(`${APP}/`);
  await B.waitText(/Add My Claude/);
  await B.click(/^Sign with wallet$/);
  await B.waitText(/Waiting for the chain|Landed/);
  ok("the words matched; owner A proposed its budget with 5 ADA collateral, reviewed in the browser; owner B signed");

  await until("connection_status", "ready", 180_000);
  const paid = await tool("pay", { to: PAYEE, amount_ada: 2, intent_id: "E2E-AGENT-1", purpose: "e2e agent" });
  if (paid.status !== "paid") throw new Error(`pay: ${JSON.stringify(paid)}`);
  ok(`the agent became ready and paid 2 ADA through its MCP tool, signed on its own machine (${paid.tx.slice(0, 12)}…)`);

  const budget = await tool("get_budget");
  if (budget.apps?.[0]?.app !== "minswap") throw new Error(`get_budget apps: ${JSON.stringify(budget.apps)}`);
  const swapped = await tool("swap", { app: "minswap", pool: "ADA ↔ TEST", amount_ada: 2, intent_id: "E2E-SWAP-1", purpose: "e2e swap" });
  if (swapped.status !== "placed") throw new Error(`swap: ${JSON.stringify(swapped)}`);
  const again = await tool("swap", { app: "minswap", pool: "ADA ↔ TEST", amount_ada: 2, intent_id: "E2E-SWAP-1", purpose: "e2e swap" });
  if (again.status !== "already_placed") throw new Error(`swap twice: ${JSON.stringify(again)}`);
  ok(`the agent swapped 2 ADA on Minswap through its MCP tool (${swapped.tx.slice(0, 12)}…, at least ${swapped.minimum_receive.amount} TEST); the same intent again placed nothing`);
  const st = await tool("order_status", { tx: swapped.tx });
  if (!["pending", "unknown"].includes(st.status)) throw new Error(`order_status: ${JSON.stringify(st)}`);
  ok(`order_status says ${st.status} (no batcher on the devnet)`);

  for (let i = 0; i < 40; i++) {
    await A.open(`${APP}/w/${POLICY}`);
    const t = await A.waitText(/Agents/);
    if (/My Claude/.test(t) && /e2e agent/.test(t) && /Swap 2 ADA/.test(t)) break;
    await sleep(3000);
  }
  await A.waitText(/My Claude[\s\S]*e2e agent|e2e agent[\s\S]*My Claude/);
  await A.waitText(/may also swap on Minswap[\s\S]*Swap 2 ADA for at least/);
  ok("the public page shows My Claude, its payment, that it may swap, and its swap");
  console.log("PASS");
} finally {
  await client?.close().catch(() => undefined);
  A.close();
  B.close();
}
