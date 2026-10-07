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
  const { instructions, manifestlyMcpUrl } = await import("../api/_agent_definition.js");
  assert.ok(instructions.length > 500, "the system prompt is substantial, not a stub");
  assert.match(manifestlyMcpUrl, /^https:\/\//);
});

test("the openai provider module loads and exposes the surface", async () => {
  const mod = await import("../api/providers/openai.js");
  for (const fn of ["createSession", "sendToSession", "sessionCannotAcceptInput"]) {
    assert.equal(typeof mod[fn], "function");
  }
});

// The two readers of agent.yaml are twins in different languages. If they
// drift, an OpenAI session runs a different prompt from the Anthropic agent
// and nothing says so.
test("both readers of agent.yaml produce the same system prompt", async () => {
  const { execFileSync } = await import("node:child_process");
  const { instructions } = await import("../api/_agent_definition.js");
  const rendered = JSON.parse(execFileSync("./bin/agent-json", { encoding: "utf8" })).system;
  assert.equal(instructions, rendered);
});
