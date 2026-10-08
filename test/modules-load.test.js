import { test } from "node:test";
import assert from "node:assert/strict";

// The suite imports _session and _signature, and until this file existed it
// imported neither of the two modules Vercel actually runs. A syntax error, a
// wrong import path or a renamed export in agent-hook.js or _store.js passed
// CI green and failed on the first real delivery.
//
// These are not behaviour tests. They assert only that the deployed modules
// load and expose what the runtime calls, which is the part nothing else
// covered.

test("the handler module loads and exports POST", async () => {
  const mod = await import("../api/agent-hook.js");
  assert.equal(typeof mod.POST, "function", "Vercel routes the request to POST");
});

test("the store module loads and exposes the surface _session.js calls", async () => {
  const { store, storeIsConfigured } = await import("../api/_store.js");
  assert.equal(typeof storeIsConfigured, "function");
  for (const method of ["setIfAbsent", "get", "set", "release"]) {
    assert.equal(typeof store[method], "function", `store.${method} is called by the resolver`);
  }
});

test("an unconfigured store reports itself unconfigured rather than throwing", async () => {
  // The degraded path: no credentials means one session per delivery and a
  // loud log, never a crash. CI has no Upstash variables, so this is the real
  // condition rather than a simulated one.
  const { storeIsConfigured } = await import("../api/_store.js");
  assert.equal(storeIsConfigured(), false);
});

// The anthropic provider calls exactly two things on its client. Neither is
// exercised by any test, and the whole one-session-per-run design rests on the
// second existing at that path: an earlier version of the design doc asserted
// there was no way to append to a session at all. This does not prove send
// behaves, only that it is where the provider reaches for it.
test("the client exposes the two session calls the handler makes", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: "sk-ant-not-a-real-key" });
  assert.equal(typeof client.beta.sessions.create, "function");
  assert.equal(typeof client.beta.sessions.events.send, "function");
});

// providers/index.js is deployed and selects what the handler runs, so a
// syntax error or a bad import path in it fails every delivery.
test("the provider module loads and selects one", async () => {
  const { provider } = await import("../api/providers/index.js");
  assert.equal(typeof provider, "function");
  assert.equal(typeof provider().createSession, "function");
});

// agent.yaml is not imported by anything, so it ships only because vercel.json
// names it in includeFiles. If that regresses, the openai provider throws at
// module load and every delivery fails -- which is the right failure, but it
// should fail here first.
test("the agent definition loads from agent.yaml", async () => {
  const { instructions, mcpServer, mcpServers } = await import("../api/_agent_definition.js");
  assert.ok(instructions.length > 500, "the system prompt is substantial, not a stub");
  assert.ok(mcpServers.length > 0, "at least one mcp server is declared");
  assert.match(mcpServer("manifestly").url, /^https:\/\//);
});

// mcp_servers is a list, and the url used to be scraped with a regex that took
// the first `url:` line in the whole file. A second server was silently
// dropped, and any `url:` key added above the list would have won instead.
test("a server is resolved by name, not by position in the file", async () => {
  const { mcpServer } = await import("../api/_agent_definition.js");
  assert.throws(() => mcpServer("not-declared"), /no mcp server "not-declared"/);
});

// agent.yaml names a provider in exactly one place: nowhere. AGENT_PROVIDER is
// the only provider-specific configuration there is, so a map keyed by provider
// name creeping back into this file is a regression worth catching.
test("agent.yaml does not name a provider", async () => {
  const { readFileSync } = await import("node:fs");
  const declared = readFileSync("agent.yaml", "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  for (const providerName of ["anthropic", "openai", "claude", "gpt"]) {
    assert.doesNotMatch(
      declared,
      new RegExp(`^\\s*${providerName}\\s*:`, "im"),
      `${providerName} is a key in agent.yaml; provider selection is AGENT_PROVIDER's job`,
    );
  }
});

test("the model is one value, not a choice keyed by provider", async () => {
  const { model } = await import("../api/_agent_definition.js");
  assert.equal(typeof model, "string", "a map here would put provider identity back in agent.yaml");
});

test("the openai provider module loads and exposes the surface", async () => {
  const mod = await import("../api/providers/openai.js");
  for (const fn of ["createSession", "sendToSession", "sessionCannotAcceptInput"]) {
    assert.equal(typeof mod[fn], "function");
  }
});

// bin/agent-json used to be Python and hardcoded everything but the prompt, so
// agent.yaml's model, mcp_servers and tools existed twice with nothing making
// them agree. It now renders what the relay parses. This asserts the whole
// body comes from the file rather than from literals in either place.
test("bin/agent-json renders agent.yaml rather than a second copy of it", async () => {
  const { execFileSync } = await import("node:child_process");
  const { instructions, name, description, mcpServers, model } = await import("../api/_agent_definition.js");
  const rendered = JSON.parse(execFileSync("./bin/agent-json", { encoding: "utf8" }));

  assert.equal(rendered.system, instructions);
  assert.equal(rendered.name, name);
  assert.equal(rendered.description, description);
  assert.equal(rendered.model.id, model);
  assert.deepEqual(
    rendered.mcp_servers,
    mcpServers.map((server) => ({ type: "url", name: server.name, url: server.url })),
  );
});

// sandbox: hosted is the customer-facing way to say "the agent runs commands".
// agent_toolset_20260401 is how Anthropic grants that, which is this adapter's
// business and nobody else's -- so it must be absent without the capability and
// present with it, and it must never appear in either config file.
test("the shell is granted by the sandbox capability, not named in config", async () => {
  const { readFileSync } = await import("node:fs");
  const { agentDefinition } = await import("../api/providers/anthropic.js");
  const { hasSandbox } = await import("../api/_capabilities.js");

  for (const file of ["agent.yaml", "capabilities.example.yaml"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /agent_toolset/, `${file} must not name a toolset`);
  }

  const toolsets = agentDefinition().tools.map((tool) => tool.type);
  assert.equal(
    toolsets.includes("agent_toolset_20260401"),
    hasSandbox,
    "the agent toolset tracks the sandbox capability",
  );
  assert.ok(toolsets.includes("mcp_toolset"), "the mcp toolset is always present");
});
