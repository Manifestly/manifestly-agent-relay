import { test } from "node:test";
import assert from "node:assert/strict";
import { provider } from "../api/providers/index.js";
import * as anthropic from "../api/providers/anthropic.js";

// A deployment is coupled to one provider by AGENT_PROVIDER, so selection is
// the only thing between a correct deployment and one that silently runs the
// wrong thing or defaults to credentials that are not configured.

test("defaults to anthropic when AGENT_PROVIDER is unset", () => {
  delete process.env.AGENT_PROVIDER;
  assert.equal(provider().name, "anthropic");
});

test("selects by name", () => {
  process.env.AGENT_PROVIDER = "anthropic";
  assert.equal(provider().name, "anthropic");
  delete process.env.AGENT_PROVIDER;
});

// Louder than a default. A deployment naming a provider that does not exist is
// misconfigured, and the alternative to throwing is running the other one.
test("an unknown provider throws rather than falling back", () => {
  process.env.AGENT_PROVIDER = "not-a-provider";
  assert.throws(() => provider(), /not one of/);
  delete process.env.AGENT_PROVIDER;
});

test("every provider exposes the surface the handler calls", () => {
  for (const module of [anthropic]) {
    assert.equal(typeof module.name, "string");
    for (const fn of ["createSession", "sendToSession", "sessionCannotAcceptInput"]) {
      assert.equal(typeof module[fn], "function", `${module.name}.${fn}`);
    }
  }
});

// The recovery path for a pointer naming a session that can no longer take
// input. Handling only 404 left an archived or terminated session failing every
// delivery for the rest of the run, since the handler rethrows anything it does
// not recognise here.
test("anthropic: a session that cannot accept input is recognised from any state 4xx", () => {
  for (const status of [400, 404, 409, 410]) {
    assert.equal(anthropic.sessionCannotAcceptInput({ status }), true, `${status} means recreate`);
  }
});

// Recreating on these would answer a missing key or a throttle by starting a
// second session for the run, which is the duplicate this design removes.
test("anthropic: auth and rate limit failures are not treated as a dead session", () => {
  for (const status of [401, 403, 429]) {
    assert.equal(anthropic.sessionCannotAcceptInput({ status }), false, `${status} must retry, not recreate`);
  }
});

test("anthropic: a server error is not treated as a dead session", () => {
  for (const status of [500, 502, 503, undefined]) {
    assert.equal(anthropic.sessionCannotAcceptInput({ status }), false);
  }
});

