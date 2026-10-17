// server/src/app.ts
// The keyless server. It can delay or withhold reads (liveness); it holds no
// wallet key, so it can never move funds (custody stays with owners' wallets).
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { mountAuth, sha256 } from "./auth.js";
import { mountPairing } from "./pairing.js";
import { olderThan } from "../../sdk/src/core/version.js";
import type { Network } from "../../sdk/src/core/index.js";
import { MIN_AGENT } from "./agent-version.js";
import { agentTxProblem, mountPending, type SubmitResult } from "./pending.js";
import type { openStore } from "./store.js";

// What the public page and the owner pages read. Never submit, accounts or pools: owners' txs
// reach the chain only through the inbox, after every required signer has signed.
const ALLOWED = [
  /^\/genesis$/,
  /^\/epochs\/latest\/parameters$/,
  /^\/blocks\/latest$/,
  /^\/addresses\/addr_test1[02-9ac-hj-np-z]{50,110}\/utxos(\/[0-9a-f]{56,120})?$/,
  /^\/assets\/[0-9a-f]{56,120}\/addresses$/,
  /^\/scripts\/[0-9a-f]{56}(\/cbor)?$/,
  /^\/scripts\/datum\/[0-9a-f]{64}\/cbor$/,
  /^\/txs\/[0-9a-f]{64}(\/utxos|\/metadata|\/redeemers|\/cbor)?$/,
];
const QUERY: Record<string, RegExp> = { page: /^([1-9]|1\d|20)$/, count: /^([1-9]\d?|100)$/, order: /^(asc|desc)$/ };
const MAX_CACHE = 5_000;
const MAX_CACHED_BODY = 256_000;
const MAX_CACHE_BYTES = 64_000_000;

const remoteIp = (c: Context) => {
  try {
    return getConnInfo(c).remote.address ?? "?";
  } catch {
    return "?";
  }
};

/** Behind a proxy every request comes from the proxy: read the client from the header it sets
 * (one clients can't forge, e.g. Cloudflare's True-Client-IP), else the connection's address. */
export function clientIpFrom(header?: string) {
  return (c: Context) => (header && c.req.header(header)?.split(",")[0]?.trim()) || remoteIp(c);
}

/** Lucid's Blockfrost client sends the key as `project_id`; Caddy drops header names with underscores, so
 * behind it the same value arrives as X-Project-Id (the Caddyfile copies it). */
const projectIdOf = (c: Context) => c.req.header("project_id") || c.req.header("x-project-id");

/** An error in Blockfrost's shape: Lucid passes `message` on to the agent instead of a generic failure. */
const bfError = (c: Context, status: 400 | 401 | 403 | 426 | 429 | 503, message: string) =>
  c.json({ status_code: 400, error: "Bad Request", message }, status);

export function createApp(d: {
  upstream: (pathAndQuery: string) => Promise<Response>;
  store: ReturnType<typeof openStore>;
  now?: () => number;
  /** Requests per client per minute (the Blockfrost quota is shared by everyone). */
  perMinute?: number;
  clientIp?: (c: Context) => string;
  /** The vault's owner key hashes from its on-chain config, or undefined when there's no vault. */
  owners: (policy: string) => Promise<string[] | undefined>;
  /** Broadcast a fully signed tx; `transient` marks errors worth retrying (network, 429, 5xx). */
  submit: (txCbor: string) => Promise<SubmitResult>;
  /** An allowance's current UTxO and agent key, from the chain. */
  allowanceOf: (policy: string, unit: string) => Promise<{ ref: string; agent: string } | undefined>;
  /** The allowance on chain whose agent is this key (pairing: when its budget has landed). */
  allowanceForAgent?: (policy: string, agent: string) => Promise<{ unit: string; ref: string } | undefined>;
  /** The network vault ids must be on ("Preprod" or "Custom"). */
  network?: string;
  maxOpenPerVault?: number;
  maxOpenPerKey?: number;
}) {
  const now = d.now ?? Date.now;
  const perMinute = d.perMinute ?? 600;
  const clientIp = d.clientIp ?? remoteIp;
  const cache = new Map<string, { at: number; status: number; body: string }>();
  let cacheBytes = 0;
  const hits = new Map<string, { minute: number; n: number }>();
  // Agent tokens live on the agent's machine, next to its AI's tools: each gets its own, smaller budget
  // of uncached reads and submits, so one leaked token can't use up the shared Blockfrost quota.
  const AGENT_PER_MINUTE = 120;
  const agentHits = new Map<string, { minute: number; n: number }>();
  const agentLimited = (tokenHash: string) => {
    const minute = Math.floor(now() / 60_000);
    if (agentHits.size > 10_000) for (const [k, v] of agentHits) if (v.minute !== minute) agentHits.delete(k);
    const h = agentHits.get(tokenHash);
    if (!h || h.minute !== minute) return agentHits.set(tokenHash, { minute, n: 1 }), false;
    return ++h.n > AGENT_PER_MINUTE;
  };
  const app = new Hono();
  app.onError((e, c) => (e instanceof SyntaxError ? c.json({ error: "malformed JSON" }, 400) : c.json({ error: "server error" }, 500)));
  // Everything but the chain proxy (which has its own bucket): sign-in, inbox, requests.
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/chain/") || c.req.method === "GET" && !/^\/(me|vaults|pending)\//.test(c.req.path)) return next();
    if (limited(`api:${clientIp(c)}`)) return c.json({ error: "too many requests" }, 429);
    return next();
  });
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
  const auth = mountAuth(app, { store: d.store, now, owners: d.owners });
  mountPending(
    app,
    {
      store: d.store, now, owners: d.owners, submit: d.submit, upstream: d.upstream, allowanceOf: d.allowanceOf, network: d.network,
      maxOpenPerVault: d.maxOpenPerVault ?? 50, maxOpenPerKey: d.maxOpenPerKey ?? 20,
    },
    auth,
  );
  mountPairing(app, { store: d.store, now, allowanceForAgent: d.allowanceForAgent ?? (async () => undefined) }, auth);

  function limited(ip: string) {
    const minute = Math.floor(now() / 60_000);
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
    const h = hits.get(ip);
    if (!h || h.minute !== minute) return hits.set(ip, { minute, n: 1 }), false;
    return ++h.n > perMinute;
  }
  const fetchWithRetry = async (key: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await d.upstream(key);
        if (res.status < 500 || attempt === 1) return res;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
  };

  app.get("/chain/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/chain".length);
    if (!ALLOWED.some((r) => r.test(path))) return c.json({ error: "not allowed" }, 404);
    if (limited(clientIp(c))) return c.json({ error: "too many requests" }, 429);
    const q = new URLSearchParams();
    for (const [k, ok] of Object.entries(QUERY)) {
      const v = url.searchParams.get(k);
      if (v === null) continue;
      if (!ok.test(v)) return c.json({ error: `bad ${k}` }, 400);
      q.set(k, v);
    }
    const key = q.size ? `${path}?${q}` : path;
    const hit = cache.get(key);
    const ttl = (status: number) => (path.startsWith("/txs/") && status === 200 ? 3_600_000 : 10_000);
    // A signed-in owner's app sends its session token as project_id (Lucid's Blockfrost client sets
    // that header): it builds txs on the current state, so it skips the cache. Everyone else, the
    // public page included, gets cached answers, so nobody can burn the shared quota by asking.
    const pid = projectIdOf(c);
    const agentToken = /^gnd_[0-9a-f]{64}$/.test(pid ?? "") && !!d.store.agentOfToken(sha256(pid!));
    if (agentToken && agentLimited(sha256(pid!))) return c.json({ error: "too many requests" }, 429);
    const fresh = !!auth.pkhOfToken(pid) || agentToken;
    if (hit && !fresh && now() - hit.at < ttl(hit.status)) return c.body(hit.body, hit.status as 200, { "content-type": "application/json" });
    let res: Response;
    try {
      res = await fetchWithRetry(key);
    } catch {
      return c.json({ error: "chain unavailable" }, 502);
    }
    if (res.status >= 500 || res.status === 429 || res.status === 403) return c.json({ error: "chain unavailable" }, 502);
    const body = await res.text();
    if ((res.status === 200 || res.status === 404) && body.length <= MAX_CACHED_BODY) {
      const old = cache.get(key);
      if (old) cacheBytes -= old.body.length, cache.delete(key);
      while (cache.size && (cache.size >= MAX_CACHE || cacheBytes + body.length > MAX_CACHE_BYTES)) {
        const [k, v] = cache.entries().next().value!;
        cacheBytes -= v.body.length;
        cache.delete(k);
      }
      cache.set(key, { at: now(), status: res.status, body });
      cacheBytes += body.length;
    }
    return c.body(body, res.status as 200, { "content-type": "application/json" });
  });

  // An agent connected by pairing has no Blockfrost key: it submits through us, and only its own allowance spend.
  app.post("/chain/tx/submit", async (c) => {
    const pid = projectIdOf(c) ?? "";
    const agent = /^gnd_[0-9a-f]{64}$/.test(pid) ? d.store.agentOfToken(sha256(pid)) : undefined;
    if (!agent) return bfError(c, 401, "the gendo server doesn't recognize this agent's token");
    if (limited(`submit:${clientIp(c)}`) || agentLimited(sha256(pid))) return bfError(c, 429, "too many requests; wait a minute");
    // gendo-agent 0.1.1 predates the version header (0.1.0 can't reach us through the proxy at all).
    const version = c.req.header("x-gendo-agent") ?? "0.1.1";
    if (olderThan(version, MIN_AGENT))
      return bfError(c, 426, `Update gendo: this agent runs ${version}, and payments need ${MIN_AGENT} or later. Reinstall it from Connect an agent in the gendo app; it keeps its key and budget.`);
    const cbor = Buffer.from(await c.req.arrayBuffer()).toString("hex");
    const al = await d.allowanceOf(agent.policy, agent.unit);
    if (!al) return bfError(c, 403, "this allowance isn't on chain any more");
    const problem = agentTxProblem(cbor, agent.policy, al.ref, al.agent, (d.network ?? "Preprod") as Network);
    if (problem) return bfError(c, 403, problem);
    d.store.setAgentVersion(al.agent, version);
    const r = await d.submit(cbor);
    if (!r.ok) console.error(`agent submit refused by the chain (${agent.unit.slice(56, 64)}): ${r.error.slice(0, 300)}`);
    return r.ok ? c.json(r.hash) : bfError(c, r.transient ? 503 : 400, `the chain refused it: ${r.error.slice(0, 500)}`);
  });

  app.get("/public/:policy", (c) => {
    const policy = c.req.param("policy");
    if (!/^[0-9a-f]{56}$/.test(policy)) return c.json({ error: "bad vault id" }, 400);
    const l = d.store.get(policy);
    const agents = d.store.labelsOf(policy);
    // A vault nobody named yet still has named agents: answer with those rather than nothing.
    if (!l && !Object.keys(agents).length) return c.json({ error: "unknown vault" }, 404);
    return c.json({ ...(l ?? { policy, name: null, listed: false }), agents });
  });

  return app;
}
