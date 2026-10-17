// app/test/driver.mjs: a small headless-Chrome driver over CDP. One browser per owner.
import { spawn } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function browser(port) {
  const bin = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const proc = spawn(bin, ["--headless=new", "--disable-gpu", "--window-size=1280,900", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/gendo-e2e-${port}-${process.pid}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") logs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const b = {
    logs,
    open: (url) => send("Page.navigate", { url }),
    text: () => evaluate("document.body ? document.body.innerText : ''"),
    async waitText(re, timeout = 120_000) {
      const end = Date.now() + timeout;
      let t = "";
      while (Date.now() < end) {
        t = (await b.text()) ?? "";
        if (re.test(t)) return t;
        await sleep(500);
      }
      throw new Error(`timed out waiting for ${re}\n--- page:\n${t.slice(0, 2000)}\n--- errors:\n${logs.slice(-5).join("\n")}`);
    },
    /** Click the first enabled button or link whose visible text matches. */
    async click(re, timeout = 60_000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const ok = await evaluate(`(() => { const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}); const el = [...document.querySelectorAll('button,a')].find((e) => re.test(e.innerText.trim()) && !e.disabled); if (!el) return false; el.click(); return true; })()`);
        if (ok) return;
        await sleep(400);
      }
      throw new Error(`no clickable ${re}\n${(await b.text())?.slice(0, 1500)}\n${logs.slice(-5).join("\n")}`);
    },
    /** Tick the checkbox inside the first label whose text matches. */
    async check(re, timeout = 60_000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const ok = await evaluate(`(() => { const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}); const l = [...document.querySelectorAll('label')].find((e) => re.test(e.innerText.trim())); const box = l?.querySelector('input[type=checkbox]'); if (!box) return false; if (!box.checked) box.click(); return true; })()`);
        if (ok) return;
        await sleep(400);
      }
      throw new Error(`no checkbox labelled ${re}`);
    },
    /** Type into an input found by its id (React-safe). */
    async fill(id, value) {
      const ok = await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error(`no input #${id}`);
    },
    close: () => { ws.close(); proc.kill(); },
  };
  return b;
}
