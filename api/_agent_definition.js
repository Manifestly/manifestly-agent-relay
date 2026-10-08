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
  Object.freeze({
    name: required(server.name, "an mcp server has no name"),
    url: required(server.url, `mcp server "${server.name}" has no url`),
  }),
);

/**
 * There is deliberately no tools list in agent.yaml.
 *
 * Both providers are being told one thing -- every declared server, with
 * permission pre-granted -- in different vocabularies. Expressing that twice,
 * once per provider, put each API's shape into a file whose job is to describe
 * the agent. So each adapter builds its own tools from mcpServers, and the
 * reason its translation is load-bearing lives next to the code that emits it.
 */

/**
 * The model, as its provider names it. Not keyed by provider: AGENT_PROVIDER is
 * the only place this configuration names one, and a map here would have put
 * provider identity back into a file that describes the agent.
 *
 * Unvalidated against the selected provider on purpose. The provider's own API
 * rejects a model that is not its own with a message naming it, and a family
 * regex here would be a guess with a shelf life.
 */
export const model = required(source.model, "no model");

/**
 * The url for a named server, which is how anything refers to one without
 * repeating it. Throwing beats defaulting: naming a server that is not declared
 * is a typo, and the alternative is an agent started with a tool pointed
 * nowhere, reporting that it has no tools.
 */
export function mcpServer(serverName) {
  const server = mcpServers.find((candidate) => candidate.name === serverName);
  if (!server) {
    const known = mcpServers.map((candidate) => candidate.name).join(", ") || "(none)";
    throw new Error(`agent.yaml: no mcp server "${serverName}" (has: ${known})`);
  }
  return server;
}
