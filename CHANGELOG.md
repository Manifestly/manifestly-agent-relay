# Changelog

Newest first. This repo is not versioned or tagged, so entries are keyed by the date the change reached `main`: if you took a copy, compare these against the date you took it.

Behaviour changes and anything that would make a reader act differently. Changes to tests, internals or wording that a running deployment cannot observe are not listed.

## 2026-09-30 — Roles may have more than one member

Documentation only, and worth reading if you set up assignments before this date.

The README said a step had to be assigned to the agent directly or to a role with **exactly one member**, and warned that adding a second member would silently stop delivery. That was true before Manifestly emitted `step_role_ready` and is no longer true: a role with several members notifies every AI agent in it. If you built your workflows around that warning, your roles can have as many members as you like.

The constraint that does exist, and was never documented: a step already assigned to a specific person produces no role notification at all.

## 2026-09-29 — One session per run

`api/_session.js` replaces `api/_claim.js`. Same two Upstash variables as before, no configuration change.

A run now gets one agent session for its life, and every delivery for that run is sent into it with `beta.sessions.events.send`. Before this, each delivery started its own session.

**Fixes dropped deliveries.** The previous design suppressed a delivery that arrived while a session for the run was already working, answering `204` and discarding it, so two steps of one run completing within the claim window meant the agent never heard about the second. Deliveries are never discarded now: one that cannot reach a session answers `503` so the sender retries. Sending into a session mid-turn is safe, because the platform queues the input and delivers it when the turn ends.

Redis now holds two keys per run rather than one. `agent:run:<id>:session` names the session and lives as long as the run; `agent:run:<id>:creating` is a short lock held across session creation. They were previously a single key governed by the lock's one-hour expiry, which is why a run whose steps completed over a morning accumulated a session per step.

A pointer naming a session that has been archived or terminated is detected and replaced. Auth failures, throttling and server errors are retried rather than answered by starting a second session.

Measured on the same daily workflow before and after: 49 model requests against 81, and 6.6M cached input tokens against 9.1M, while doing strictly more work.

## 2026-09-28 — Single flight per run

Superseded two days later by the entry above. Listed because a copy taken in that window has it.

Deliveries naming a run that already had a session were suppressed while that session reported `running`, which stopped several sessions planning the same work after three of them intended to file the same five issues. A follow-up on 2026-09-29 made the takeover path atomic, closing a race where two deliveries could both find an idle session and both proceed. Both are moot now: this design also dropped the deliveries it suppressed, which is what one session per run fixed.

## 2026-09-18 — Trigger on any delivery naming a run

Replaces an allowlist of event names, which silently ignored real deliveries twice while returning `204` and looking healthy. Which event arrives depends on how the step was assigned, so the condition is now whether the delivery names a run.

## 2026-09-18 — `always_allow` on the MCP toolset

`agent.yaml` only. The platform default is `always_ask`, which suspends every MCP call waiting for a confirmation event that a webhook-started agent has nobody to answer. Before this the agent emitted its tool calls and went idle having done nothing, with no error anywhere. If you wrote your own agent definition rather than using this one, check it carries this.
