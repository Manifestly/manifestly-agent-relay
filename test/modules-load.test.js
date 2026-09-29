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

// The handler calls exactly two things on the Anthropic client. Neither is
// exercised by any test, and the whole one-session-per-run design rests on the
// second existing at that path: an earlier version of the design doc asserted
// there was no way to append to a session at all. This does not prove send
// behaves, only that it is where the handler reaches for it.
test("the client exposes the two session calls the handler makes", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: "sk-ant-not-a-real-key" });
  assert.equal(typeof client.beta.sessions.create, "function");
  assert.equal(typeof client.beta.sessions.events.send, "function");
});
