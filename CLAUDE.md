# Manifestly Agent Relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a Claude Managed Agents session to do the work. Manifestly can only POST its own shape to a URL and Anthropic needs a different body with a key in a header, so something has to sit between them. This is that something, and nothing more.

## Commands

- `npm test`: Node's built-in runner, no framework. Zero test dependencies on purpose.
- `./bin/agent-json`: render `agent.yaml` as the JSON body `/v1/agents` expects
- `./bin/agent-apply`: sync `agent.yaml` to the live agent (needs `ANTHROPIC_API_KEY`, `CMA_AGENT_ID`)
- `npx vercel deploy --prod`: deploy. See Deployment below for why this is manual

## Environment Variables

Five required in production, all set through the Vercel CLI (see below):

- `MANIFESTLY_WEBHOOK_SIGNING_SECRET`: account-level, from Settings. Verify it is 32 hex characters
- `ANTHROPIC_API_KEY`: the key sessions are created with. Scope it to one workspace
- `CMA_AGENT_ID` / `CMA_ENVIRONMENT_ID` / `CMA_VAULT_ID`: what every session is started from

Two more for the single-flight claim, supplied by the Upstash Redis marketplace integration under either spelling:

- `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`
- `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN`

Without them the relay still runs and still starts sessions. It logs `claim_store_unconfigured` and reverts to one session per delivery, which is the duplicate behaviour Single Flight Per Run exists to stop.

## Architecture

The relay is a pure function of request, environment, and one claim key. No database of its own, no filesystem, no in-memory state across invocations.

The state lives where it belongs. The **Run** in Manifestly holds the process, meaning step completion, recorded data, comments, approval status, and the review decisions with their snapshots. The **Execution** in Manifestly holds the delivery: request body, response code, response body, which means the `session_id` this handler returns is already recorded against the run that caused it. The **Session** at Anthropic holds the agent's transcript.

That closes the audit chain without the relay remembering anything: Run, then Execution, then `session_id`, then Session.

### The one exception, and why it is not one

The relay holds a single short-lived key per run, in Redis, to stop several deliveries starting several sessions for the same run. That looks like the thing this section forbids and is not, for a reason worth keeping straight.

The Run records **what work happened**. The claim records **that a process is currently working**. Those are different facts with different lifetimes. A Run should not carry a column meaning "a session is in flight": it is true for minutes, it is wrong the moment a session dies, and nothing would ever correct it. A key with a TTL is the right home precisely because expiry is what makes a crashed session self-healing rather than a permanently stuck run.

So the rule still stands, restated: **the day this needs a database for anything describing the work is the day something has moved into it that belongs in the Run.** Coordination state about in-flight processing is not that.

## Single Flight Per Run

Several deliveries can name one run within milliseconds. A rejection reopens N steps, an approval unblocks a section, a comment arrives while either is in flight. Every one of them used to create its own session.

This is not theoretical. Three sessions once picked up the same step, two of them posting near-identical plans five seconds apart, all three intending to file the same five GitHub issues. Only an unrelated network restriction stopped it being fifteen. Note also that `comment_created` is an agent event, so a person holding a normal conversation in run comments spawns a session per message.

`api/_claim.js` decides; `api/_store.js` is the Redis behind it, via Upstash's own `@upstash/redis` client rather than hand-rolled HTTP, so the one part that talks to a third party is the vendor's code against the vendor's service. The mechanism is `SET key value NX EX`, which is atomic, so of N simultaneous callers exactly one proceeds.

The decision logic is unit-tested against an in-memory implementation of those semantics, and the store was additionally driven against the real Upstash instance: three concurrent claims, one winner, plus takeover, release and TTL expiry.

**Suppressing a delivery loses nothing, and that is what makes this safe.** The payload carries ids only and the agent reads live run state through MCP, so the surviving session sees everything the suppressed ones pointed at. This is the ids-only payload paying for itself.

Three things that decide the shape, all read from the API rather than assumed:

- **There is no append.** Session events are read-only and `sessions.update` touches only tools, mcp_servers, budget and metadata. Input reaches a session only at `create`. So deliveries are folded into one session by being dropped, not by being delivered into it.
- **An agent cannot end its own session.** `end_turn` ends a turn. The session then sits `idle` waiting for input a fire-and-forget trigger never sends.
- **Status is readable.** `running`, `idle`, `terminated`, `rescheduling`. So "is the holder still working" is a fact to read rather than a timeout to guess, and `running` is the only suppress condition. Because sessions start `idle`, a status check alone would let a second delivery conclude the first had finished, which is why the claim covers the create-to-running gap.

**If the sessions API ever gains a way to post an event into a running session, redo this.** One session per run with appends is strictly better: nothing is dropped, and the claim degrades to a lookup.

**The claim is not a safety gate and must not fail closed.** An unreachable store degrades to the old behaviour and logs `claim_store_unavailable`, because suppressing on a store outage would stop the agent running at all, which is worse than the duplicates. The durable answer to duplicate *external writes* is idempotency at the action, not only at the trigger.

`CLAIM_TTL_SECONDS` is a backstop, not the mechanism, since the status check governs while a session id is held. It is provisional at one hour, and the `suppressed_duplicate` log is what should replace it with a measured value rather than another guess.


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

Two consequences. Publishing a reference implementation of a signature check means owning its correctness for everyone who forks it, and forks do not receive fixes. And the README is written for someone setting this up for the first time, while this file is written for whoever changes it next; do not merge the two.

## Deployment

Deploys are manual CLI uploads. The repo is owned by the Manifestly GitHub org and the Vercel project is on a personal Hobby account, and Vercel's Git integration for organization-owned repositories is a paid-team feature. So there is no auto-deploy on push, and a code change needs `npx vercel deploy --prod` run by hand.

Only the **production alias** is public. Deployment-specific URLs sit behind Vercel Authentication, which answers with a 401 that looks exactly like this relay's own rejection. Read the body before concluding the signature check ran.

## Set Environment Variables From The CLI

Both secrets pasted into Vercel's web form arrived truncated: a 32-character signing secret stored as 19, and an API key as a fragment. Neither failed at the time; they surfaced much later as unexplained 401s from two different systems.

```bash
read -rs VALUE
printf '%s' "$VALUE" | wc -c          # check it before
printf '%s' "$VALUE" | npx vercel env add NAME production
```

`printf`, not `echo`. A trailing newline on the signing secret makes every HMAC mismatch, and the symptom is a 401 on every genuine delivery with nothing explaining it.

Values added this way are stored as secrets and cannot be read back: `vercel env pull` returns `[SENSITIVE]`. The only way to inspect one is from inside a running function.

## Managed Agents Constraints Worth Knowing

**`mcp_toolset` defaults to `permission_policy: always_ask`.** That suspends every MCP call waiting for a confirmation event. Correct for an interactive agent and fatal for one started by a fire-and-forget webhook, because nobody is listening to answer. The symptom is an agent that emits its tool calls and goes idle having done nothing, with no error anywhere. Set `always_allow` explicitly; `agent.yaml` does and carries a comment saying why.

**Vault credentials substitute into headers and bodies, never query strings.** A service that authenticates with `?key=...` receives the literal placeholder and returns its own auth error. Check whether it also accepts a header: Airbrake's documentation describes only the query parameter and accepts `Authorization: Bearer` perfectly well.

**`vault_ids` is create-only.** Vaults attach when the session is created and cannot be added later, so a session started without one has an agent with no credentials and failures that read as confusion rather than as authentication.

## Git Conventions

- Default branch is `main`, matching `manifestly-mcp`. The Rails repo's `master` is legacy and not a precedent.
- Stage files by name; never `git add -A` or `git add .`
- Keep the README's description of behavior in step with the code. It has already drifted once: it described an event allowlist for three commits after the allowlist was removed.

Branch protection is not yet enabled, and everything here was pushed straight to the default branch during the spike. That was fine for a repo that did not exist yet and stopped being fine once it started receiving production webhooks. Enabling protection and requiring a PR is part of moving this off a personal Vercel account.
