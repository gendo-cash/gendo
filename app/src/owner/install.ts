import { olderThan } from "../../../sdk/src/core/version.ts";

// How an AI app installs gendo-agent with this pairing code already in it: the npm package at an exact
// version (it ships a pinned dependency tree); Claude Desktop gets its bundle from the app's own domain.
export const AGENT_VERSION = "0.2.0";
export const CLAUDE_BUNDLE = "/dl/gendo.mcpb";
export const mcpConfig = (code: string, origin: string) => ({
  command: "npx" as const,
  args: ["-y", `@gendo-cash/agent@${AGENT_VERSION}`, "--pair", code, "--server", origin],
});
export const configLine = (code: string, origin: string) => `npx ${mcpConfig(code, origin).args.join(" ")}`;
const encoded = (code: string, origin: string) => encodeURIComponent(btoa(JSON.stringify(mcpConfig(code, origin))));
export const cursorLink = (code: string, origin: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=gendo&config=${encoded(code, origin)}`;
export const lmStudioLink = (code: string, origin: string) => `lmstudio://add_mcp?name=gendo&config=${encoded(code, origin)}`;

/** Which gendo an agent runs, as the owners' Agents tab shows it; undefined until the agent has reported. */
export function versionNote(version: string | undefined, v: { latest: string; min: string }): { text: string; tone: "ok" | "update" | "required" } | undefined {
  if (!version) return undefined;
  if (olderThan(version, v.min)) return { text: `gendo ${version}, update required to pay`, tone: "required" };
  if (olderThan(version, v.latest)) return { text: `gendo ${version}, update available`, tone: "update" };
  return { text: `gendo ${version}`, tone: "ok" };
}
