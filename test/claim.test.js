import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRun, runClaimKey, PENDING } from "../api/_claim.js";

// A real implementation of the SET NX EX semantics the claim depends on, not a
// stub that returns what the code expects. Two claims driven against one of
// these race exactly as two serverless invocations race against one Redis.
function memoryStore() {
  const values = new Map();
  return {
    values,
    async setIfAbsent(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async release(key) {
      values.delete(key);
    },
  };
}

const neverRunning = async () => false;
const alwaysRunning = async () => true;

test("the first delivery for a run proceeds", async () => {
  const store = memoryStore();
  const result = await claimRun(store, 42, 60, neverRunning);
  assert.equal(result.proceed, true);
  assert.equal(result.takeover, false);
});

test("of two simultaneous deliveries exactly one proceeds", async () => {
  const store = memoryStore();
  const [a, b] = await Promise.all([
    claimRun(store, 42, 60, neverRunning),
    claimRun(store, 42, 60, neverRunning),
  ]);
  assert.equal([a, b].filter((r) => r.proceed).length, 1);
  const loser = [a, b].find((r) => !r.proceed);
  assert.equal(loser.reason, "session_being_created");
});

test("three simultaneous deliveries still produce exactly one session", async () => {
  const store = memoryStore();
  const results = await Promise.all(
    [1, 2, 3].map(() => claimRun(store, 42, 60, neverRunning)),
  );
  assert.equal(results.filter((r) => r.proceed).length, 1);
});

test("deliveries for different runs do not block each other", async () => {
  const store = memoryStore();
  const [a, b] = await Promise.all([
    claimRun(store, 1, 60, neverRunning),
    claimRun(store, 2, 60, neverRunning),
  ]);
  assert.equal(a.proceed, true);
  assert.equal(b.proceed, true);
});

test("a delivery arriving while the held session is running is suppressed", async () => {
  const store = memoryStore();
  await store.set(runClaimKey(42), "ses_running");
  const result = await claimRun(store, 42, 60, alwaysRunning);
  assert.equal(result.proceed, false);
  assert.equal(result.reason, "session_running");
  assert.equal(result.holder, "ses_running");
});

test("a delivery arriving after the held session stopped takes over", async () => {
  const store = memoryStore();
  await store.set(runClaimKey(42), "ses_finished");
  const result = await claimRun(store, 42, 60, neverRunning);
  assert.equal(result.proceed, true);
  assert.equal(result.takeover, true);
  assert.equal(result.previous, "ses_finished");
});

test("the session status is only consulted once a real session id is held", async () => {
  const store = memoryStore();
  let asked = 0;
  await claimRun(store, 42, 60, async () => {
    asked += 1;
    return false;
  });
  assert.equal(asked, 0, "a first delivery must not wait on a status lookup");
});

test("a claim released after a failed create lets the next delivery through", async () => {
  const store = memoryStore();
  const first = await claimRun(store, 42, 60, neverRunning);
  assert.equal(first.proceed, true);
  // What the handler does when sessions.create throws: without this the run is
  // suppressed until the TTL expires, which is the whole window the agent is
  // meant to be working in.
  await store.release(runClaimKey(42));
  const second = await claimRun(store, 42, 60, neverRunning);
  assert.equal(second.proceed, true);
});

test("the key is namespaced per run", () => {
  assert.equal(runClaimKey(42), "agent:run:42");
  assert.notEqual(runClaimKey(42), runClaimKey(421));
});

test("PENDING is distinguishable from any session id", () => {
  assert.equal(PENDING, "pending");
  assert.ok(!PENDING.startsWith("ses_"));
});
