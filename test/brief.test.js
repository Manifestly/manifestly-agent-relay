import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentBrief } from "../api/agent-hook.js";

// The brief is the only place this repo can tell a session what it is for.
// A session's credential is account-wide and the assignment lookup spans every
// run, so "act only on this run" is the boundary rather than a pleasantry:
// without it a session woken about one run has no reason not to work another.
const delivery = {
  event: "run_completed",
  run_id: 4242,
  run_step_id: null,
  department_id: 7,
};

test("names the run as the scope, not merely as the subject", () => {
  const brief = assignmentBrief(delivery, true, "sesn_abc");

  assert.match(brief, /You are the session for run 4242/);
  assert.match(brief, /act only on this run/);
});

test("says that another run's steps are not this session's to work", () => {
  const brief = assignmentBrief(delivery, true, "sesn_abc");

  assert.match(brief, /any other run/);
  assert.match(brief, /Do not work them/);
});

test("scopes the fallback when the delivery names no step", () => {
  const brief = assignmentBrief(delivery, true, "sesn_abc");

  // The old wording said "find your own assignments in the run" while the only
  // question the agent could ask spanned every run. Naming the run keeps the
  // instruction answerable.
  assert.match(brief, /find your assignments on run 4242/);
  assert.doesNotMatch(brief, /find your own assignments in the run/);
});

test("carries the session id once there is one", () => {
  const brief = assignmentBrief(delivery, true, "sesn_abc");

  assert.match(brief, /session_id=sesn_abc/);
});

test("says it has no session id on the first message rather than leaving it blank", () => {
  // create() returns the id, so the first brief is built before one exists.
  // An agent with no identity to report has been observed generating its own
  // and then citing it as fact, so the absence is stated.
  const brief = assignmentBrief(delivery, false, null);

  assert.match(brief, /session_id=\(not known on this first message/);
  assert.match(brief, /rather than inventing one/);
});

test("still scopes the first message, where no session id exists yet", () => {
  const brief = assignmentBrief(delivery, false, null);

  assert.match(brief, /You are the session for run 4242/);
  assert.match(brief, /act only on this run/);
});

test("names the step when the delivery carries one", () => {
  const brief = assignmentBrief({ ...delivery, run_step_id: 555 }, true, "sesn_abc");

  assert.match(brief, /run_step_id=555/);
  assert.doesNotMatch(brief, /find your assignments on run/);
});
