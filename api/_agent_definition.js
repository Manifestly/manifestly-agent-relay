import { readFileSync } from "node:fs";

/**
 * agent.yaml is the source of truth, and this is the second reader of it.
 *
 * Anthropic takes a persisted agent: bin/agent-json renders agent.yaml and
 * bin/agent-apply syncs it, so the relay never sends a system prompt. OpenAI
 * takes the instructions inline on every session create, so the relay does need
 * them at runtime. Reading the same file is the alternative to a second copy,
 * which CLAUDE.md is explicit about not wanting.
 *
 * The split rule is deliberately identical to bin/agent-json's, because they
 * are twins in two languages. Change one and change the other.
 *
 * agent.yaml is not imported by anything, so Vercel will not trace it. It ships
 * because vercel.json names it in includeFiles. Without that this throws at the
 * first delivery rather than failing quietly, which is the behaviour wanted:
 * an OpenAI deployment with no instructions is not an agent.
 */
const yaml = readFileSync(new URL("../agent.yaml", import.meta.url), "utf8");

function systemBlock() {
  const block = yaml.split("system: |\n", 1 + 1)[1]?.split("\nmcp_servers:", 1 + 1)[0];
  if (!block) throw new Error("agent.yaml has no system block");

  return block
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n")
    .trim() + "\n";
}

function mcpServerUrl() {
  const url = yaml.match(/^\s*url:\s*(\S+)\s*$/m)?.[1];
  if (!url) throw new Error("agent.yaml names no MCP server url");

  return url;
}

export const instructions = systemBlock();
export const manifestlyMcpUrl = mcpServerUrl();
