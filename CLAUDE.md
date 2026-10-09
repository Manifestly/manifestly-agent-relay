# Manifestly Agent Relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a Claude Managed Agents session to do the work. Manifestly can only POST its own shape to a URL and Anthropic needs a different body with a key in a header, so something has to sit between them. This is that something, and nothing more.

## Commands

- `npm test`: Node's built-in runner, no framework. Zero test dependencies on purpose.
- `./bin/agent-json`: render `agent.yaml` as the JSON body `/v1/agents` expects. Node, and it renders what the relay parses; it was Python and hardcoded everything but the prompt
- `./bin/agent-apply`: sync `agent.yaml` to the live agent (needs `ANTHROPIC_API_KEY`, `ANTHROPIC_AGENT_ID`). Refuses without `capabilities.yaml`, because parts of the definition derive from it and applying `sandbox: none` blind takes a live agent's shell away
- `./bin/capabilities-discover`: print the `capabilities.yaml` matching what a provider account already permits. Read-only, needs only the provider's API key, discovers every id itself
- `./bin/capabilities-apply`: make a provider account match `capabilities.yaml`. Dry run unless `--apply`. Never creates a credential and never deletes anything
- `./bin/cma-inspect`: list the vaults, environments, agents and credentials on the account (needs `ANTHROPIC_API_KEY` only)
- `./bin/cma-credential`: add an `environment_variable` credential to a vault without the value entering shell history
- `./bin/cma-credential-rm`: remove a credential from a vault, after showing what it is and asking. Hard delete, no undo
- `./bin/openai-inspect`: list the Agents API vaults and their credentials (needs `OPENAI_API_KEY` only)
- `./bin/openai-credential`: add the `static_bearer` credential an OpenAI deployment needs, creating the vault if you give it no vault id. Reads the MCP server URL from `agent.yaml` rather than taking it as an argument
- `./bin/openai-credential-rm`: remove one, after showing what it is and asking. Hard delete, no undo
- `npx vercel ls`: confirm a merge deployed. Deploys are automatic; see Deployment

## Environment Variables

A deployment is coupled to one provider. Six required in production, all set through the Vercel CLI (see below):

- `AGENT_PROVIDER`: which provider this deployment runs. Defaults to `anthropic` when unset; an unrecognised value throws at the first delivery rather than falling back, because the alternative to throwing is running the other one
- `AGENT_MODEL`: the model sessions run, named the way its provider names it. Deployment config rather than part of the agent, because one `agent.yaml` cannot carry a model for two deployments on different providers and we run both. It sits beside `AGENT_PROVIDER`, which is the thing it has to agree with; nothing validates the pairing, because the provider's own API rejects a model that is not its own and a family regex here would be a guess with a shelf life. Required at runtime only on OpenAI, which sends the model on every session create. On Anthropic sessions name a persisted agent that already carries its model, so only `bin/agent-apply` needs it
- `AGENT_EFFORT`: how hard the model works per turn, and the second cost knob after `allowed_tools`. Anthropic `low|medium|high|xhigh|max`, OpenAI those plus `none|minimal`. Unset means `high` on Anthropic, because that is what this agent's definition has always shipped with and falling through to the API default would quietly re-tune the live agent on the next `bin/agent-apply`; unset means the API's own default on OpenAI, because copying Anthropic's `high` across would raise this provider's cost on the strength of the other's history. The two defaults disagree on purpose
- `AGENT_SANDBOX`: `none` or `hosted`, whether the agent gets a shell. Defaults to `none`. It is an environment variable and not a `capabilities.yaml` key for one reason: the relay needs it on every OpenAI session create, and that file is gitignored and so absent from the Vercel build, where a runtime read would resolve to `none` and the agent would report that it cannot run commands with nothing saying why. A leftover `sandbox:` key in the file is refused rather than ignored

- `MANIFESTLY_WEBHOOK_SIGNING_SECRET`: account-level, from Settings. Verify it is 32 hex characters
- `ANTHROPIC_API_KEY`: the key sessions are created with. Scope it to one workspace
- `ANTHROPIC_AGENT_ID` / `ANTHROPIC_ENVIRONMENT_ID` / `ANTHROPIC_VAULT_ID`: what every session is started from. Named `CMA_*` until 2026-10-08, which said nothing a reader could connect to `AGENT_PROVIDER=anthropic`; the old names are still read

On an `AGENT_PROVIDER=openai` deployment those three are replaced by:

- `OPENAI_API_KEY`: the key sessions are created with. It needs three scopes, not one: Agents write, Vaults write, and Responses write. Agents alone returns 401 at the first turn rather than at session creation, which reads as a code problem. Permission changes take minutes to propagate
- `OPENAI_VAULT_ID`: holds a `static_bearer` credential carrying the agent's Manifestly API key, matched to the MCP server url

There is no `OPENAI_MODEL`. The model is `agent.yaml`'s, for both providers, because it describes the agent rather than this account.

`api/_config.js` is the list, with what needs each variable and why. It is also the only thing that reads `process.env` outside the handler, so adding a variable without adding it there is the drift to avoid. A missing id used to surface as a provider API error on the first real delivery, which reads as a code fault.

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

## The Delivery Contract, And What It Leaves To Us

**Manifestly's agent hook reports what happened. Scoping work and managing concurrency are the consumer's responsibility.** That is the stated position and it is a defensible one: the platform cannot know which deliveries a given consumer considers the same unit of work, and a dedup or lease imposed upstream would suppress true events for everyone else.

What it means here is that several deliveries can describe one piece of work, and the relay is the thing that has to notice.

- An assignment and an applicability change are separate facts about the same step, emitted by unrelated code paths that do not know about each other.
- A step can become applicable more than once, and each transition is a delivery. We have seen one step transition four times, with two of those producing deliveries half an hour apart.
- A delivery carries no indication that another delivery for the same work is in flight or already handled.

When that happened to us, two sessions worked the same step and each did the whole thing, so every outbound action in it was taken twice. Nothing was corrupted only because the single write involved happened to be idempotent, which is luck rather than containment: the next collision may land on something that is not.

So the single-flight behaviour in `_session.js` is not an optimisation. It is this relay's discharge of a responsibility the platform has explicitly handed us, and anything that weakens it is a correctness change rather than a performance one.

The platform's side of the line is narrower than it sounds. It owes us deliveries that describe states the run was actually in. A delivery emitted from an intermediate value during a recompute, which is then corrected microseconds later in the same pass, is not something that happened, and that is a platform bug rather than something this relay should work around.

## One Session Per Run

The agent is a participant on a run, not a function invoked once per step. It holds one session for the life of the run, and every delivery for that run is sent into it, while humans and other agents work the same run alongside it. A rejection reopening N steps, an approval unblocking a section, a comment arriving while either is in flight: all of them reach the session the agent is already thinking in.

That is the point, and the deduplication is a consequence rather than the goal. The agent that handled step 3 is the one that sees step 4, so it knows what it already read and already decided instead of rediscovering the run from nothing.

The failure this replaced was not theoretical. Three sessions once picked up the same step, two of them posting near-identical plans five seconds apart, all three intending to file the same five GitHub issues. Only an unrelated network restriction stopped it being fifteen. Note also that `comment_created` is an agent event, so a person holding a normal conversation in run comments used to spawn a session per message.

`api/_session.js` decides; `api/_store.js` is the Redis behind it, via Upstash's own `@upstash/redis` client rather than hand-rolled HTTP, so the one part that talks to a third party is the vendor's code against the vendor's service.

**Two keys, because their lifetimes are incompatible.** `agent:run:<id>:agent:<id>:session` names the session and lives as long as the run. `agent:run:<id>:agent:<id>:creating` is a lock held across one `sessions.create` call and expires on its own, so a crashed invocation costs one delivery rather than wedging the run. These were one key once, governed by the lock's short TTL, and that is exactly why a run whose steps completed over a morning accumulated a session per step.

**Sessions outlive the pointer, so the pointer is the binding constraint.** The fourteen days is derived from how long a run may stall, and said nothing about how long the session it names lives, which is the obvious next question and was unanswered for months. Both providers persist a session until it is explicitly deleted, with no automatic expiration and no Zero Data Retention eligibility. So the pointer always expires first, which is the direction this design assumes. It is refreshed on every delivery, so it measures silence rather than run age.

**Both are keyed on the run and the agent, not the run alone.** A run can have steps assigned to more than one agent, and each is a separate worker with its own continuous context. Keyed on the run alone, the second agent's delivery finds the first agent's pointer and sends its work into a session belonging to someone else: one agent is told to do work it was not assigned, and the session that should have received it never hears about it. Nothing errors. Where a relay serves agents belonging to different parties, that is a leak rather than a mix-up. `agent_id` has always been on the wire in the delivery body; it was simply not read.

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

## Two Config Files, And The Line Between Them

**`agent.yaml` is the agent**: prompt, MCP servers. No model: see `AGENT_MODEL` above. The same for everyone running this relay, so it is checked in and must stay generic.

**`capabilities.yaml` is one deployment's reach**: `secrets` by name with the hosts each authenticates to, and `egress`. It names the specific systems a deployment's workflows use, which is exactly what `agent.yaml` must not. Gitignored, with a committed `.example`. Absent means MCP only and no egress, so the template runs unconfigured.

**Never commit it, and do not let a script write an id into it.** This repo is public and its own template rule is that no account id belongs in it. `bin/capabilities-discover` therefore prints the agent, environment, vault and credential ids to **stderr** and the config to stdout, so redirecting the output cannot capture them. They are not credentials, but a reader cannot tell which opaque `vlt_` string is safe to expose, so none of them are treated as safe.

Only `secrets` and `egress` live there, and only the reconcile scripts read them, which run on a machine that has the file. Anything the request path needs is an environment variable; that is the line, and it is why `sandbox` is `AGENT_SANDBOX`.

**`AGENT_PROVIDER` is the only place any configuration names a provider.** Nothing else in either file does, and a test asserts no provider name appears as a key in `agent.yaml`. This was got wrong once, with `model`, `tools` and `environment` keyed under a `providers:` section: that is the two APIs' shapes written into a file whose job is to describe intent.

`allowed_tools` on an `mcp_servers` entry is the same translation problem in miniature, and the clearest example of why the config is neutral. OpenAI has an `allowed_tools` array, where null means every tool. Anthropic has no such field: an allowlist there is `default_config.enabled: false` plus a `configs` entry per tool that stays on. One neutral declaration, two shapes that look nothing alike.

So there is no `tools` list in either file. Both providers are told one thing -- every declared server, with permission pre-granted -- in different vocabularies, and each adapter builds its own from `mcpServers`. `always_allow` and `required: true` live next to the code that emits them, with the reason each is load-bearing. `agent_toolset_20260401` is likewise how Anthropic grants a shell, which is that adapter's business and appears in no config file.

**One parser, one reader.** `api/_agent_definition.js` parses `agent.yaml` with the `yaml` package and `bin/agent-json` renders what it parses. Before 2026-10-08 there were three readers and two of them did not parse: `bin/agent-json` hardcoded name, description, model, `mcp_servers` and `tools` as Python literals and read only the system block, and `_agent_definition.js` scraped the server url with a regex matching the first `url:` line in the file, which silently drops a second `mcp_servers` entry. The file this repo called its source of truth held a second copy of every value except the prompt.

The test that `bin/agent-json` renders the file catches **drift, not duplication**: a hardcoded value that happens to agree still passes. Verified by mutation in both directions.

`agent.yaml` is imported by nothing, so Vercel will not trace it. It ships because `vercel.json` names it in `includeFiles`. If that regresses, an OpenAI deployment throws at module load rather than starting an agent with no instructions.

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

**The vaults, environments and agents API, since none of this is in the docs we could find.** Everything is under `https://api.anthropic.com/v1/`, with `x-api-key`, `anthropic-version: 2023-06-01` and `anthropic-beta: managed-agents-2026-04-01`. `bin/cma-inspect` does the reads.

- Discovery needs only the API key. `GET /vaults`, `GET /environments` and `GET /agents` list them, so no id has to be known in advance. The ids are not secret; only the key is.
- Vault credentials hang off a sub-resource: `GET /vaults/{id}/credentials`. The vault object itself carries no credentials. Reads never return secret values.
- **Updating an environment is `POST`, not `PATCH`, and it MERGES.** `PATCH` returns 405; the SDK's `update` posts to `/v1/environments/{id}`. Omitted fields preserve the existing value, at the top level and inside `config`, which the SDK states outright: *"Fields default to null; on update, omitted fields preserve the existing value."* To change one thing, send one thing.
  This entry said the opposite for months -- that `config` was replaced wholesale and needed read-modify-write -- and that advice was worse than useless, because read-modify-write is itself how you clobber a field you did not read. Neither object needs it: the README records that credentials are independent objects with "no read-modify-write to get wrong here", observed while widening the GitHub token's scope, and the environment merges per the types above.
  **The one real replace is `config.networking`**, because it is a discriminated union of `unrestricted` and `limited` rather than a bag of fields, so sending it at all means sending a whole policy. Inside it, `allow_mcp_servers` is documented as "Defaults to `false`" without the "on creation" qualifier its sibling `allow_package_managers` carries, so assume a `networking` that omits it turns MCP egress off, which cuts the agent off from its servers with no error anywhere. Send `allow_mcp_servers` whenever you send `networking`. Whether it truly resets on update is not established from the types and has not been tested; test it rather than trusting either reading.
- The secret field on a credential create is `auth.secret_value`. The API names missing fields one at a time, so an empty body is a usable schema probe and creates nothing.

**An egress allowlist is a boundary on one provider and documentation on the other.** Anthropic's environment carries a network policy and `bin/capabilities-apply` writes `egress` into it, so anything else is refused at the proxy. OpenAI has no environment object to write a policy to: a credential's `hosts` scope only where its secret is substituted, and the sandbox's outbound access is not constrained by `capabilities.yaml` at all. An agent on a hosted OpenAI sandbox was observed reaching two hosts no credential scoped it to. Do not describe `egress` as containment without naming which provider you mean.

**Host scope is not verb scope, on either provider.** A credential is substituted for the hosts you name, and every operation the underlying token permits is then available. Nothing in the config narrows a token to reads. Where an API offers no read-only credential, the agent's step instructions are the only thing standing between it and the rest of that API, and that is worth knowing before deciding what a credential may touch.

**A vault credential listing is read-after-write lagged.** Listing an OpenAI vault's credentials immediately after creating one returned the previous contents; a second call seconds later was correct. Do not verify a write by the listing that follows it without a retry.

**Credential types are a constraint, not a style choice.** `static_bearer` takes `mcp_server_url` and nothing else, so it cannot authenticate an ordinary host. `environment_variable` is the egress-substituted form for everything else, carrying `injection_location` and its own `networking.allowed_hosts`. The name misleads: the value is injected into headers at the proxy and never enters the sandbox, which is the property you want when the agent writes prose into systems people read. Mirror an existing credential's shape rather than reasoning from the names; the README's earlier wording read as though the two were alternatives and sent a reader to the wrong one.

**Reaching a new host takes two allowlist entries.** The environment's `config.networking.allowed_hosts` permits egress to the host; the credential's own `networking.allowed_hosts` scopes which host its secret is injected for. The failure modes are distinguishable and worth knowing apart: `403` with `x-deny-reason: host_not_allowed` is the environment, `401` is the credential, and a `404` on a resource you expect to exist is usually the credential's own scope at the far end.

**`vault_ids` is create-only.** Vaults attach when the session is created and cannot be added later, so a session started without one has an agent with no credentials and failures that read as confusion rather than as authentication.

## Git Conventions

- Default branch is `main`, matching `manifestly-mcp`. The Rails repo's `master` is legacy and not a precedent.
- Stage files by name; never `git add -A` or `git add .`
- Keep the README's description of behavior in step with the code. It has already drifted once: it described an event allowlist for three commits after the allowlist was removed.

