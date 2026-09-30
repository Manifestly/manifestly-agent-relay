# Changelog

Behaviour changes only, newest first. A copy of this repo does not update itself, so this is how you tell whether yours is missing something that matters. Anything not listed here is a change to documentation, tests or internals that a running deployment cannot observe.

## One session per run

`api/_session.js` replaces `api/_claim.js`. Requires the same two Upstash variables as before; no configuration changes.

A run now gets one agent session for its life, and every delivery for that run is sent into it with `beta.sessions.events.send`. Before this, each delivery started its own session.

**Fixes dropped deliveries.** The previous design suppressed a delivery that arrived while a session for the run was already working, answering `204` and discarding it. Two steps of one run completing within the claim window meant the agent never heard about the second. Deliveries are never discarded now: one that cannot reach a session answers `503` so the sender retries. Sending into a session mid-turn is safe, because the platform queues the input and delivers it when the turn ends.

Redis now holds two keys per run rather than one. `agent:run:<id>:session` names the session and lives as long as the run; `agent:run:<id>:creating` is a short lock held across session creation. They were previously a single key governed by the lock's one-hour expiry, which is why a run whose steps completed over a morning accumulated a session per step.

A pointer naming a session that has been archived or terminated is detected and replaced. Auth failures, throttling and server errors are retried rather than answered by starting a second session.

Measured on the same daily workflow before and after: 49 model requests against 81, and 6.6M cached input tokens against 9.1M, while doing strictly more work.

## Single flight per run

Superseded by the entry above; listed because a copy taken during this window has it.

Deliveries naming a run that already had a session were suppressed while that session reported `running`. This stopped several sessions planning the same work, which had produced three sessions intending to file the same five issues. It also dropped the deliveries it suppressed, which is what the next change fixed.

## Trigger on any delivery naming a run

Replaces an allowlist of event names, which silently ignored real deliveries twice. Which event arrives depends on how the step was assigned, so the condition is now whether the delivery names a run.

## Set `always_allow` on the MCP toolset

`agent.yaml` only. The platform default is `always_ask`, which suspends every MCP call waiting for a confirmation event that a webhook-started agent has nobody to answer. Before this, the agent emitted its tool calls and went idle having done nothing, with no error anywhere. If you wrote your own agent definition rather than using this one, check it carries this.

## Documentation correction, 30 September 2026

No code change. The README previously said a step had to be assigned to the agent directly or to a role with **exactly one member**, and warned that adding a second member would silently stop delivery. That was true before Manifestly emitted `step_role_ready`, and it is no longer true: a role with several members notifies every AI agent in it. If you built a workflow around that warning, your roles can have as many members as you like.
