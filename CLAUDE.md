# Manifestly Agent Relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a Claude Managed Agents session to do the work. Manifestly can only POST its own shape to a URL and Anthropic needs a different body with a key in a header, so something has to sit between them. This is that something, and nothing more.

## Commands

- `npm test`: Node's built-in runner, no framework. Zero test dependencies on purpose.
- `./bin/agent-json`: render `agent.yaml` as the JSON body `/v1/agents` expects
- `./bin/agent-apply`: sync `agent.yaml` to the live agent (needs `ANTHROPIC_API_KEY`, `CMA_AGENT_ID`)
- `npx vercel deploy --prod`: deploy. See Deployment below for why this is manual

## Environment Variables

All five required in production, all set through the Vercel CLI (see below):

- `MANIFESTLY_WEBHOOK_SIGNING_SECRET`: account-level, from Settings. Verify it is 32 hex characters
- `ANTHROPIC_API_KEY`: the key sessions are created with. Scope it to one workspace
- `CMA_AGENT_ID` / `CMA_ENVIRONMENT_ID` / `CMA_VAULT_ID`: what every session is started from

## Architecture

The relay is a pure function of request and environment. No database, no cache, no filesystem, no in-memory state across invocations. Under a hundred lines.

The state lives where it belongs. The **Run** in Manifestly holds the process, meaning step completion, recorded data, comments, approval status, and the review decisions with their snapshots. The **Execution** in Manifestly holds the delivery: request body, response code, response body, which means the `session_id` this handler returns is already recorded against the run that caused it. The **Session** at Anthropic holds the agent's transcript.

That closes the audit chain without the relay remembering anything: Run, then Execution, then `session_id`, then Session.

**The day this needs a database is the day something has moved into it that belongs in the Run.** The only honest candidate today is deduplication on `delivery_id`, deliberately left out: at a weekly cadence a duplicate costs one extra session that finds the work already done.

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

- Stage files by name; never `git add -A` or `git add .`
- Keep the README's description of behavior in step with the code. It has already drifted once: it described an event allowlist for three commits after the allowlist was removed.
