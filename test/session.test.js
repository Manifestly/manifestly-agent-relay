import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSession, runSessionKey, createLockKey, CREATING } from "../api/_session.js";

// A real implementation of the SET NX EX semantics the resolver depends on, not
// a stub that returns what the code expects. Two resolutions driven against one
// of these race exactly as two serverless invocations race against one Redis.
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

const noPause = async () => {};
const options = (pause = noPause) => ({ lockTtlSeconds: 60, pointerAttempts: 8, pause });

test("the first delivery for a run creates its session", async () => {
  const store = memoryStore();
  const result = await resolveSession(store, 42, options());
  assert.equal(result.action, "create");
});

// The regression this whole change exists for. Under the claim-based design a
// second delivery naming a run that already had a session was answered with
// suppressed_duplicate and a 204: the delivery was dropped and the agent never
// heard about that step. Every delivery now reaches the session.
test("a later delivery for the same run joins the existing session", async () => {
  const store = memoryStore();
  await store.set(runSessionKey(42), "sesn_existing");
  const result = await resolveSession(store, 42, options());
  assert.equal(result.action, "send");
  assert.equal(result.sessionId, "sesn_existing");
});

test("a delivery arriving while the agent works still reaches the session", async () => {
  // No status check anywhere in the resolver: the platform queues inputs sent
  // mid-turn. A running session is indistinguishable from an idle one here, and
  // that is the point.
  const store = memoryStore();
  await store.set(runSessionKey(42), "sesn_busy");
  const result = await resolveSession(store, 42, options());
  assert.equal(result.action, "send");
  assert.equal(result.sessionId, "sesn_busy");
});

test("of two simultaneous first deliveries one creates and the other joins it", async () => {
  const store = memoryStore();
  // Stands in for the winner publishing its pointer after sessions.create
  // returns, which is what the loser is waiting on.
  const publishAsWinner = async () => {
    await store.set(runSessionKey(42), "sesn_winner");
  };
  const [first, second] = await Promise.all([
    resolveSession(store, 42, options(publishAsWinner)),
    resolveSession(store, 42, options(publishAsWinner)),
  ]);

  const actions = [first, second].map((r) => r.action).sort();
  assert.deepEqual(actions, ["create", "send"]);
  assert.equal([first, second].find((r) => r.action === "send").sessionId, "sesn_winner");
});

test("no delivery is discarded when several land at once", async () => {
  const store = memoryStore();
  const publishAsWinner = async () => {
    await store.set(runSessionKey(42), "sesn_winner");
  };
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(() => resolveSession(store, 42, options(publishAsWinner))),
  );

  assert.equal(results.filter((r) => r.action === "create").length, 1, "exactly one session");
  assert.equal(results.filter((r) => r.action === "defer").length, 0, "nothing is dropped");
  assert.equal(results.filter((r) => r.action === "send").length, 4);
});

test("a delivery defers rather than dropping when the pointer never appears", async () => {
  // The creator crashed between taking the lock and publishing. Deferring turns
  // this into a 503 and a Manifestly retry; the old code returned 204 and lost
  // the delivery outright.
  const store = memoryStore();
  await store.setIfAbsent(createLockKey(42), CREATING);
  const result = await resolveSession(store, 42, options());
  assert.equal(result.action, "defer");
});

test("the waiter polls a bounded number of times", async () => {
  const store = memoryStore();
  await store.setIfAbsent(createLockKey(42), CREATING);
  let pauses = 0;
  await resolveSession(store, 42, options(async () => { pauses += 1; }));
  assert.equal(pauses, 8);
});

test("runs resolve independently of one another", async () => {
  const store = memoryStore();
  const [first, second] = await Promise.all([
    resolveSession(store, 1, options()),
    resolveSession(store, 2, options()),
  ]);
  assert.equal(first.action, "create");
  assert.equal(second.action, "create");
});

test("the pointer and the lock are separate keys", async () => {
  // They were one key, with the lock's short TTL governing both. That is what
  // produced a new session for every step of a run that spanned an hour.
  assert.notEqual(runSessionKey(42), createLockKey(42));
  assert.equal(runSessionKey(42), "agent:run:42:session");
  assert.notEqual(runSessionKey(42), runSessionKey(421));
});
