import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * agent.yaml, parsed once. The only reader of that file in any language.
 *
 * It used to have three readers and two of them did not parse: bin/agent-json
 * hardcoded name, description, model, mcp_servers and tools as Python literals
 * and read only the system block, and this file scraped the server url with a
 * regex. So the file the repo calls its source of truth held a second copy of
 * every value except the prompt, and the regex took the FIRST `url:` line in
 * the file, which silently drops a second mcp_servers entry.
 *
 * Both are gone. bin/agent-json now renders what this module parses, so the
 * drift the repo exists to avoid is structurally impossible rather than
 * something two files are asked to agree about.
 *
 * agent.yaml is imported by nothing, so Vercel will not trace it. It ships
 * because vercel.json names it in includeFiles. Without that this throws at
 * module load rather than starting an agent with no instructions.
 */
const source = parse(readFileSync(new URL("../agent.yaml", import.meta.url), "utf8"));

function required(value, what) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`agent.yaml: ${what}`);
  }
  return value;
}

export const name = required(source.name, "no name");
export const description = required(source.description, "no description");

// Trailing newline preserved: the prompt shipped to Anthropic has always ended
// with one, and a definition that differs only in whitespace still counts as a
// change to the live agent.
export const instructions = required(source.system, "no system block").trimEnd() + "\n";

export const mcpServers = required(source.mcp_servers, "no mcp_servers").map((server) =>
  Object.freeze({ ...server, url: required(server.url, `mcp server "${server.name}" has no url`) }),
);

/**
 * The url for a named server, which is how a provider's tool entry refers to
 * one without repeating it. Throwing beats defaulting: a tool naming a server
 * that is not defined is a typo, and the alternative is an agent that starts
 * with a tool pointed nowhere and reports that it has no tools.
 */
export function mcpServer(serverName) {
  const server = mcpServers.find((candidate) => candidate.name === serverName);
  if (!server) {
    const known = mcpServers.map((candidate) => candidate.name).join(", ") || "(none)";
    throw new Error(`agent.yaml: tool names mcp server "${serverName}", which is not in mcp_servers (${known})`);
  }
  return server;
}

/**
 * The section for one provider. Absent means refuse, for the same reason
 * provider() refuses an unknown AGENT_PROVIDER: a deployment configured for a
 * provider this file says nothing about has no model and no tools, and
 * inventing them would start an agent nobody described.
 */
export function providerSection(providerName) {
  const section = source.providers?.[providerName];
  if (!section) {
    const known = Object.keys(source.providers ?? {}).join(", ") || "(none)";
    throw new Error(`agent.yaml: no providers.${providerName} section (has: ${known})`);
  }
  return section;
}
