# Manifestly Agent Relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a Claude Managed Agents session to do the work. Manifestly can only POST its own shape to a URL and Anthropic needs a different body with a key in a header, so something has to sit between them. This is that something, and nothing more.

## Commands

- `npm test`: Node's built-in runner, no framework. Zero test dependencies on purpose.
- `./bin/agent-json`: render `agent.yaml` as the JSON body `/v1/agents` expects
- `./bin/agent-apply`: sync `agent.yaml` to the live agent (needs `ANTHROPIC_API_KEY`, `CMA_AGENT_ID`)
- `npx vercel ls`: confirm a merge deployed. Deploys are automatic; see Deployment

## Environment Variables

Five required in production, all set through the Vercel CLI (see below):

- `MANIFESTLY_WEBHOOK_SIGNING_SECRET`: account-level, from Settings. Verify it is 32 hex characters
- `ANTHROPIC_API_KEY`: the key sessions are created with. Scope it to one workspace
- `CMA_AGENT_ID` / `CMA_ENVIRONMENT_ID` / `CMA_VAULT_ID`: what every session is started from

Two more so a run can find its session, supplied by the Upstash Redis marketplace integration under either spelling:

- `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`
- `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN`

Without them the relay still runs and still starts sessions. It logs `session_store_unconfigured` and reverts to one session per delivery, which is the behaviour One Session Per Run exists to replace.

## Architecture

The relay is a pure function of request, environment, and the run's session pointer. No database of its own, no filesystem, no in-memory state across invocations.

The state lives where it belongs. The **Run** in Manifestly holds the process, meaning step completion, recorded data, comments, approval status, and the review decisions with their snapshots. The **Execution** in Manifestly holds the delivery: request body, response code, response body, which means the `session_id` this handler returns is already recorded against the run that caused it. The **Session** at Anthropic holds the agent's transcript.

That closes the audit chain without the relay remembering anything: Run, then Execution, then `session_id`, then Session.

### The one exception, and why it is not one

The relay holds one key per run in Redis, naming the session that belongs to that run. That looks like the thing this section forbids and is not, for a reason worth keeping straight.

The Run records **what work happened**. The pointer records **where the agent's continuous context for this run lives**, which is a fact about Anthropic's side of the boundary, not about the process. A Run should not carry a column holding another vendor's session id: it means nothing to Manifestly, no Manifestly feature reads it, and the Execution already records the `session_id` this handler returns, which is what closes the audit chain.

So the rule still stands, restated: **the day this needs a database for anything describing the work is the day something has moved into it that belongs in the Run.** Coordination state about in-flight processing is not that.

## One Session Per Run

The agent is a participant on a run, not a function invoked once per step. It holds one session for the life of the run, and every delivery for that run is sent into it, while humans and other agents work the same run alongside it. A rejection reopening N steps, an approval unblocking a section, a comment arriving while either is in flight: all of them reach the session the agent is already thinking in.

That is the point, and the deduplication is a consequence rather than the goal. The agent that handled step 3 is the one that sees step 4, so it knows what it already read and already decided instead of rediscovering the run from nothing.

The failure this replaced was not theoretical. Three sessions once picked up the same step, two of them posting near-identical plans five seconds apart, all three intending to file the same five GitHub issues. Only an unrelated network restriction stopped it being fifteen. Note also that `comment_created` is an agent event, so a person holding a normal conversation in run comments used to spawn a session per message.

`api/_session.js` decides; `api/_store.js` is the Redis behind it, via Upstash's own `@upstash/redis` client rather than hand-rolled HTTP, so the one part that talks to a third party is the vendor's code against the vendor's service.

**Two keys, because their lifetimes are incompatible.** `agent:run:<id>:session` names the session and lives as long as the run. `agent:run:<id>:creating` is a lock held across one `sessions.create` call and expires on its own, so a crashed invocation costs one delivery rather than wedging the run. These were one key once, governed by the lock's short TTL, and that is exactly why a run whose steps completed over a morning accumulated a session per step.

**Sending into a busy session is not an error.** The platform queues an input sent while the agent is mid-turn and delivers it when the turn ends; queued inputs are flushed only when a turn dies from retry exhaustion. Nothing in the resolver reads session status, and that absence is deliberate.

Two things that decide the shape, both read from the API:

- **Appending is `beta.sessions.events.send`.** A prior version of this document asserted flatly that session events were read-only and that input reached a session only at `create`, and named that as one of three facts "read from the API rather than assumed". It was assumed. `sessions.events` carries `list send stream toolRunner`; `send` opens a new thread in the session, which is why `threads` has `retrieve`/`list`/`archive` and no `create`. The whole suppression design existed because of that unchecked claim, and this document had already named the discovery of an append as the trigger to redo it.
- **An agent cannot end its own session.** `end_turn` ends a turn. The session then sits `idle`, holding the run's context for the next delivery, which is now what we want rather than something to clean up.

**The pointer is not a safety gate and must not fail closed.** An unreachable store degrades to one session per delivery and logs `session_store_unavailable`, because refusing to act on a store outage would stop the agent working at all, which is worse than duplicate sessions. The durable answer to duplicate *external writes* is idempotency at the action, not only at the trigger.

**A delivery is never dropped.** Where the old design answered a losing race with 204 and discarded the delivery, a delivery that cannot reach a session now answers 503, so Manifestly's retry is what resolves it.


## Verify Over The Raw Bytes

Manifestly signs the exact bytes it sends, which are JSON canonicalization (`to_json_c14n`) output, and the signature is HMAC-SHA256 delivered as `sha256=<hex>`.

Verify against the unparsed request body. Parsing the JSON and re-serializing it will not reproduce those bytes, so every real delivery fails while every hand-written fixture passes. That is a test suite that is green precisely where production is broken.

This is why the handler takes `request.text()` rather than a parsed body, and why the `todo` test in `test/signature.test.js` exists: the current fixtures pin the HMAC arithmetic against a digest computed by `openssl`, not the canonicalization. Fill it with a captured delivery.

## Do Not Filter On Event Name

An agent hook receives only agent-work notifications, and which name arrives depends on how the step was assigned:

| Step assigned to | Event |
|---|---|
| a membership | `step_assigned` / `step_became_applicable` |
| a role with several members and no per-run mapping | `step_role_ready` |
| nothing yet, agent joins as a run participant | `run_invited` |

An earlier version listed the two names it expected and silently ignored real deliveries twice, returning 204 and looking perfectly healthy both times. The condition is now "does this delivery name a run," and the agent works out what is waiting for it from the run state, which its system prompt already tells it to do.

A delivery carrying no `run_id` is logged rather than dropped. An unrecognised delivery must never be indistinguishable from a handled one.

## Fail Closed, And Say Why

A missing or unset signing secret rejects everything. A bad signature rejects. A failed session creation returns non-200 so Manifestly's delivery retry is meaningful rather than acking a delivery that produced nothing.

The 401 path logs three facts, body size, whether the header arrived and whether a secret is configured, because a bare 401 is indistinguishable from a platform login page returning the same status, which cost an afternoon. It logs no secret material and no digests.

## agent.yaml Is The Source Of Truth

The agent's system prompt, model, tools and MCP servers live in `agent.yaml`. `bin/agent-json` renders it; `agent.json` is generated and gitignored. Never hand-maintain a second copy. Two files that must agree is the drift this repo exists to avoid.

`bin/agent-apply` omits `version`, which applies unconditionally. That is the documented mode for a loop syncing a checked-in definition, and it means this file wins over anything edited in the Console.

**Keep the system prompt process-agnostic.** It describes how the agent operates; each Manifestly workflow's step text describes what the work is. That split is what lets one agent serve every workflow and lets the person who owns a process change it without touching this repo. If Airbrake, or any other specific system, appears in `agent.yaml`, something has gone wrong.

## This Repo Is A Template

It is meant to be handed to customers. No account ids, no workspace names, no deployment URLs, no anything specific to our own setup. Those are environment variables and stay that way.

Two consequences. Publishing a reference implementation of a signature check means owning its correctness for everyone who copies it, and a copy does not receive fixes: behaviour changes belong in `CHANGELOG.md`, which is the only way a reader can tell a stale copy from a current one. And the README is written for someone setting this up for the first time, while this file is written for whoever changes it next; do not merge the two, and do not tell the same story in both.

## Deployment

The Vercel project is connected to this repository, so deploys are automatic. A push to a branch produces a Preview deployment; a merge to `main` produces a Production one. Confirm with `npx vercel ls`: after a merge the newest Production entry should be seconds old.

**Every merge redeploys, including a documentation-only one.** The production alias moves to a new deployment each time. Harmless when the code is identical, but it means a production deployment being minutes old is not evidence that any code changed.

That connection is recent. This section used to describe deploying by hand, and three things from that period still matter.

`vercel git connect` fails with three different errors in sequence, and the first two read like the answer without being it: no GitHub login connection on the Vercel account, then the Vercel GitHub App not installed on the organisation, and only then any plan restriction. `gh api /orgs/<org>/installations` lists what is actually installed. Worth having if the connection is ever lost, and worth knowing when a customer sets up their own copy.

**A CLI deploy is attributed to the HEAD commit's author, not to the CLI user.** `vercel whoami` showing the account that owns the project is not enough: if the commit author's email is not on that Vercel account, `npx vercel deploy --prod` creates a deployment that is immediately **Blocked**, with `vercel inspect` reporting "the commit author doesn't have permission to create deployments for this project". The notification email leads with "Upgrade to Pro", which is not the fix. The fix is that every address you commit under is verified on the Vercel account; it bit us when a global git identity changed between deploys, twelve commits under one address and the next three under another. If a CLI deploy is ever needed and blocks, deploying from a copy of the tree with no `.git` directory removes the author to check.

Whether that check applies to git-triggered deploys is not established. The first merge after connecting deployed clean even though GitHub authored the merge commit server-side under an address this repo's config never set, which is the case the manual flow could not survive. One observation is not a rule, so do not rely on it either way.

Only the **production alias** is public. Deployment-specific URLs sit behind Vercel Authentication, which answers with a 401 that looks exactly like this relay's own rejection. Read the body before concluding the signature check ran.

## Set Environment Variables From The CLI

Why, and the symptom, are in the README. Two details that matter when changing things here:

```bash
read -rs VALUE
printf '%s' "$VALUE" | wc -c          # check it before
printf '%s' "$VALUE" | npx vercel env add NAME production
```

`printf`, not `echo`. A trailing newline on the signing secret makes every HMAC mismatch, and the symptom is a 401 on every genuine delivery with nothing explaining it.

Values added this way are stored as secrets and cannot be read back: `vercel env pull` returns `[SENSITIVE]`. The only way to inspect one is from inside a running function.

## Managed Agents Constraints Worth Knowing

The README lists the ones that bite during setup. These matter when changing `agent.yaml` or the session call.

**Never remove `always_allow` from the `mcp_toolset`.** The platform default is `always_ask`, which suspends every MCP call waiting for a confirmation event that a fire-and-forget webhook has nobody to answer. The agent then emits its tool calls and goes idle having done nothing, with no error anywhere. `agent.yaml` sets it and carries a comment saying why.

**The sandbox egress allowlist does not govern every network path the agent has.** Ordinary HTTP out of the sandbox is proxied and refused per host, with a `403` carrying `x-deny-reason: host_not_allowed` and a plain-text body naming the host. The agent's own `web_fetch` tool is not subject to it: asked for a URL the proxy refuses, `curl` gets the 403 and `web_fetch` returns the document. So do not treat the allowlist as a complete control on what the agent can reach, and when an agent reports a host as blocked, ask which path it tried.

**`vault_ids` is create-only.** Vaults attach when the session is created and cannot be added later, so a session started without one has an agent with no credentials and failures that read as confusion rather than as authentication.

## Git Conventions

- Default branch is `main`, matching `manifestly-mcp`. The Rails repo's `master` is legacy and not a precedent.
- Stage files by name; never `git add -A` or `git add .`
- Keep the README's description of behavior in step with the code. It has already drifted once: it described an event allowlist for three commits after the allowlist was removed.

