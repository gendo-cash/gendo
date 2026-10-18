// The paying agent's tools (budget, pay, approval, swap, order status), shared by the MCP server (separate signer) and gendo-agent (paired,
// in-process signer). None of them can raise a limit: only the owners can.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { budget, orderStatusOf, pay, requestApproval, swap, type AgentSession } from "../../sdk/src/node/session.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });

const payment = {
  to: z.string().describe("Payee's exact Cardano address (addr_test1...). Must be on the approved list."),
  amount_ada: z.number().positive().describe("Amount in ADA, e.g. 4.5"),
  intent_id: z.string().min(1).describe("Stable id of what you're paying, e.g. the invoice number. Reuse it on retries."),
  purpose: z.string().describe("Short human-readable reason, recorded on-chain with the payment"),
};

/**
 * `session` resolves to the agent's session, or to why it isn't ready yet (gendo-agent before its budget lands).
 * `onResult` sees every tool result (gendo-agent reconnects when the server stops accepting its token).
 */
export function registerTools(
  server: McpServer,
  session: () => Promise<AgentSession | { notReady: string }>,
  onResult?: (r: unknown) => void,
  /** Something the user should hear with every result (gendo-agent: an update is available). */
  notice?: () => string | undefined,
) {
  const ready = async <T>(run: (s: AgentSession) => Promise<T>) => {
    const s = await session();
    const out = "notReady" in s ? { status: "not_ready", message: s.notReady } : await run(s);
    onResult?.(out);
    const n = notice?.();
    return json(n ? { ...(out as object), notice: n } : out);
  };

  server.registerTool(
    "get_budget",
    {
      title: "Check the budget",
      description: "What you may spend right now: per-payment and per-period limits, what's left this period, when it resets, approved payees, expiry, and whether the owners paused spending.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => ready((s) => budget(s)),
  );

  server.registerTool(
    "pay",
    {
      title: "Pay from the allowance",
      description:
        "Pay an approved payee within the limits. Returns paid, already_paid (this intent_id was paid before; nothing new was sent), or blocked with a code and the next step. Over-limit amounts are blocked by the chain; use request_approval for those.",
      inputSchema: payment,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => pay(s, args)),
  );

  server.registerTool(
    "swap",
    {
      title: "Swap on a DeFi app",
      description:
        "Swap inside your budget on an app the owners enabled for you (see get_budget's apps), e.g. sell ADA for a token on Minswap. The chain enforces the owners' rules, including a worst acceptable price. Returns placed (with the minimum you'll receive), already_placed, or blocked with a code and the next step. Proceeds go to the vault's treasury, not back to your budget.",
      inputSchema: {
        app: z.string().describe('The app, e.g. "minswap"'),
        pool: z.string().describe('A pool from get_budget, e.g. "ADA ↔ NACRE". If get_budget says pools "any": any Minswap pool, by label, LP asset name, or its two assets as "lovelace/<policy id + name hex>"'),
        amount_ada: z.number().positive().optional().describe("ADA to sell"),
        asset: z.object({ unit: z.string(), quantity: z.number().positive() }).optional().describe("Or: the pool's other asset to sell (policy id + name, and quantity)"),
        intent_id: z.string().min(1).describe("Stable id for this swap. Reuse it on retries."),
        purpose: z.string().describe("Short human-readable reason, recorded on-chain"),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => swap(s, args)),
  );

  server.registerTool(
    "order_status",
    {
      title: "Check a swap",
      description: "Whether a swap placed with the swap tool is still pending, was filled (and what the vault received), or was refunded.",
      inputSchema: { tx: z.string().describe("The tx returned by swap") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => orderStatusOf(s, args.tx)),
  );

  server.registerTool(
    "request_approval",
    {
      title: "Ask the owners to approve a payment",
      description:
        "For a payment over your limits. Sends it to the vault owners to review and sign; nothing is paid until they do.",
      inputSchema: { ...payment, reason: z.string().describe("Why this payment should exceed the limits") },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ready((s) => requestApproval(s, args)),
  );
}
