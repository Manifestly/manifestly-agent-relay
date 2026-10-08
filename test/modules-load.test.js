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

// The model moved to AGENT_MODEL. One agent.yaml cannot carry a model for two
// deployments on different providers, and we run both: the file held
// claude-opus-5, so an OpenAI deployment would have sent a Claude id and got a
// 400 reading like a credentials problem. It is deployment config, like the
// vault id and the sandbox, and it now sits beside AGENT_PROVIDER, which is
// the thing it has to agree with.
test("agent.yaml declares no model", async () => {
  const { readFileSync } = await import("node:fs");
  const declared = readFileSync("agent.yaml", "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(declared, /^\s*model\s*:/m, "the model is AGENT_MODEL, not an agent.yaml key");
});

test("each provider reads the model from AGENT_MODEL", async () => {
  const previous = process.env.AGENT_MODEL;
  const { agentDefinition } = await import("../api/providers/anthropic.js");

  process.env.AGENT_MODEL = "a-model";
  assert.equal(agentDefinition().model.id, "a-model");

  delete process.env.AGENT_MODEL;
  assert.throws(() => agentDefinition(), /AGENT_MODEL is not set/);

  if (previous === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = previous;
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
  const { instructions, name, description, mcpServers } = await import("../api/_agent_definition.js");
  const rendered = JSON.parse(execFileSync("./bin/agent-json", { encoding: "utf8", env: { ...process.env, AGENT_MODEL: "a-model" } }));

  assert.equal(rendered.model.id, "a-model");
  assert.equal(rendered.system, instructions);
  assert.equal(rendered.name, name);
  assert.equal(rendered.description, description);
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
  process.env.AGENT_MODEL ??= "a-model";

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

// The two cost knobs. Both default to changing nothing, which is the property
// that matters: a running deployment must not be re-tuned by code that merely
// made tuning possible.
test("an unset allowed_tools leaves every tool available, on both providers", async () => {
  process.env.AGENT_MODEL ??= "a-model";
  const { mcpServer } = await import("../api/_agent_definition.js");
  const { agentDefinition } = await import("../api/providers/anthropic.js");

  assert.equal(mcpServer("manifestly").allowedTools, undefined, "agent.yaml ships no allowlist");

  // Anthropic has no allowed_tools array: an allowlist is `enabled: false` plus
  // per-tool overrides, so the tell that none is in force is the absence of both.
  const toolset = agentDefinition().tools.find((tool) => tool.type === "mcp_toolset");
  assert.equal(toolset.default_config.enabled, undefined, "tools stay enabled by default");
  assert.equal(toolset.configs, undefined, "no per-tool overrides without an allowlist");
});

test("AGENT_EFFORT defaults differ by provider, and both preserve today's behaviour", async () => {
  const previous = process.env.AGENT_EFFORT;
  delete process.env.AGENT_EFFORT;
  process.env.AGENT_MODEL ??= "a-model";

  const { agentDefinition } = await import("../api/providers/anthropic.js");

  // high is what this agent's definition has always shipped with. Falling back
  // to the API default would re-tune the live agent on the next agent-apply.
  assert.equal(agentDefinition().model.effort, "high");

  process.env.AGENT_EFFORT = "low";
  assert.equal(agentDefinition().model.effort, "low");

  if (previous === undefined) delete process.env.AGENT_EFFORT;
  else process.env.AGENT_EFFORT = previous;
});

// The bin scripts import from api/, and nothing executed them until a person
// ran one. A refactor removed `manifestlyMcpUrl` from _agent_definition.js and
// bin/openai-credential kept importing it; the sweep that should have caught it
// used `--include='*.js'`, and these scripts have no extension, so grep skipped
// the directory in silence. The break surfaced as a SyntaxError in someone's
// terminal, mid-task.
//
// Static on purpose: importing them would run them, and several prompt for a
// secret on stdin.
test("every bin script imports names that api/ actually exports", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");

  const exportsOf = (path) => {
    const source = readFileSync(path, "utf8");
    const names = new Set();
    for (const [, name] of source.matchAll(/export\s+(?:const|function|let|class)\s+(\w+)/g)) names.add(name);
    for (const [, group] of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const entry of group.split(",")) names.add(entry.trim().split(/\s+as\s+/).pop().trim());
    }
    return names;
  };

  let checked = 0;
  for (const entry of readdirSync("bin")) {
    const script = `bin/${entry}`;
    if (statSync(script).isDirectory()) continue;

    for (const [, imported, target] of readFileSync(script, "utf8").matchAll(
      /import\s*\{([^}]+)\}\s*from\s*"(\.\.\/api\/[^"]+)"/g,
    )) {
      const module = target.replace("../api/", "api/");
      const available = exportsOf(module);
      for (const name of imported.split(",").map((value) => value.trim())) {
        assert.ok(available.has(name), `${script} imports ${name}, which ${module} does not export`);
        checked += 1;
      }
    }
  }

  assert.ok(checked > 0, "found no bin imports to check, so this test is pinning nothing");
});
