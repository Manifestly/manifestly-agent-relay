# Manifestly agent relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a [Claude Managed Agents](https://docs.claude.com/en/api/agent-sdk) session to do the work.

It is about forty lines. Manifestly cannot call the Anthropic API directly, because the delivery body and headers are Manifestly's own shape, so something has to sit between them. This is that something.

It is a reference implementation, not a service. You run your own copy, and it is yours to change. Nothing in the code is tied to a particular host: the handler is a standard Web `Request`/`Response` function and the only state is a Redis store reached over HTTP, so it runs unchanged on any platform that routes a request to a function. We deploy it to Vercel, which is why the deployment instructions and most of the hard-won operational notes below are Vercel's. Moving it elsewhere is a different deploy command, not different code.

## What it does

1. Verifies the `X-Manifestly-Signature` header against the raw request body.
2. Logs and ignores any delivery that does not name a run.
3. Looks up the session that belongs to that run.
4. Sends the delivery into that session, or starts one if the run does not have one yet.
5. Returns 200 only if the delivery reached a session, so a failure is retried.

The delivery carries ids and nothing else. The agent reads the run through the Manifestly MCP server, which means the instructions for the work live in your workflow's step text, not in this code. Nothing here knows what process it triggered.

**It does not filter on event name, deliberately.** Which event you get depends on how the step was assigned: `step_assigned` or `step_became_applicable` for a step assigned to a membership, `step_role_ready` for a role with several members, `run_invited` when the agent joins the run as a participant. An earlier version listed the two it expected and silently ignored real deliveries twice, returning 204 and looking healthy. An agent hook only ever receives agent-work notifications, so the useful question is whether the delivery names a run.

## Deploy

We use Vercel. Any platform that routes an HTTP request to a function works, and the only thing that changes is this section.

```
npm install
npx vercel deploy --prod
```

Set the environment variables from `.env.example` **through the CLI, not a dashboard**, then redeploy:

```
printf '%s' "$VALUE" | npx vercel env add NAME production
```

Use `printf` rather than `echo`, which appends a newline. Read the first entry under "Things that cost us a day" before deciding the web form is easier.

## Setting it up

**In Manifestly.** Create an AI agent under Settings > Users, choosing the department the work lives in. Copy its API key on the creation screen; it is shown exactly once. Leave the endpoint URL blank for now.

Then take the webhook signing secret from Settings > Account. Two things to know about it: it is account-level rather than per-hook, and it is shown only when created or rotated. If nobody saved it, the only way to obtain it is to rotate, which invalidates it for every other webhook consumer in the account at the same moment. Check what else is subscribed before you rotate.

**In Anthropic.** Create a vault, an environment and an agent. `bin/cma-inspect` lists all three for your account and needs nothing but an API key, so run it first and after every change.

The vault holds one credential per service the agent reaches. The two credential types are not interchangeable and the names do not suggest what they do:

- `static_bearer` is for MCP servers only. Its one field is `mcp_server_url`. It cannot authenticate an ordinary host.
- `environment_variable` is for everything else. It carries `injection_location` and its own `networking.allowed_hosts`, and the real value is substituted into request headers at egress for those hosts only. The agent holds a placeholder, never the secret, which matters if your agent writes long prose anywhere a value could be echoed into.

**Name the variable for the scope it actually has.** The agent cannot read the secret, but it can read the variable's name, and it will reason from it. Ours reported its GitHub credential as read-only on the strength of a name ending `_READ_TOKEN`, which was correct at the time and would have been a confident falsehood the moment we widened the grant without renaming. A name that outlives its scope is a lie told to your own agent.

So the Manifestly MCP credential is a `static_bearer` keyed to your MCP server URL, and every other service is an `environment_variable` scoped to its host. `bin/cma-credential` creates one without the value ever reaching your shell history or the process table.

**Credentials are independent objects, and they reach running sessions.** Each lives on its own and adding one cannot disturb the others, so there is no read-modify-write to get wrong here. A credential added after a session started still arrives: substitution is resolved per call rather than frozen at session start, so you can roll or revoke one on a live agent without restarting it. We added a credential more than seven hours into a session and the agent picked it up on its next request.

**If your agent's tools include the agent toolset, it reaches these hosts with a shell.** The credential is not limited to something MCP-shaped: the agent runs `curl` and any HTTPS API inside the allowlist is reachable. That is more capability than "an environment variable for another service" suggests, and it is worth knowing before you decide what a credential is allowed to touch.

**The allowlist is two layers and both are needed.** The environment's `config.networking.allowed_hosts` decides whether the sandbox may reach a host at all; the credential's own `networking.allowed_hosts` decides which host its secret is injected for. Miss the first and you get `403` with `x-deny-reason: host_not_allowed`. Miss the second and you get the service's own `401`.

Then create an agent whose `mcp_servers` lists your Manifestly MCP server and whose `tools` includes a matching `mcp_toolset` entry. Keep the agent's system prompt free of any single process's details: it should say how the agent works, while each workflow's step text says what the work is. That is what lets one agent serve every workflow.

**Back in Manifestly.** Set this relay's URL as the agent's endpoint, then assign steps to the agent.

Inference is billed to your own Anthropic account, not through Manifestly. What a run costs depends entirely on what your workflow asks the agent to do, so watch the first few before scheduling anything daily.

## Assigning steps

Assign the step to the agent directly, or to a role the agent belongs to. Both work, and which event arrives depends on which you chose, which is why this relay does not filter on event name.

A role with exactly one member resolves to that member, and the delivery arrives as `step_assigned` or `step_became_applicable`. A role with several members does not resolve, and every AI agent in the role is notified with `step_role_ready`. Adding a human backup to a role alongside the agent is safe.

Prefer a role. A workflow exported as a template carries the role name, so whoever imports it maps their own agent, or a person, onto the same role. A membership id does not port, and swapping the agent for a person is the whole argument for assigning work to a role rather than to a worker.

**The one trap.** A step that is already assigned to a specific person produces no role notification at all. Role delivery and direct assignment are alternatives rather than layers, so an agent sitting in a role will never be woken for a step somebody has already taken. Header steps are never delivered either; assign the substep.

## Things that cost us a day

**Set the environment variables from the CLI, not a dashboard.** Both secrets we pasted into Vercel's web form arrived truncated: a 32-character signing secret stored as 19, and an API key as a fragment. Neither failed at the time. They surfaced much later as unexplained 401s from two different systems. Verify the length before and after.

**Your agent's MCP tools probably default to asking permission.** On Claude Managed Agents, `mcp_toolset` defaults to `permission_policy: always_ask`, which suspends every call waiting for a confirmation event. That is right for an interactive agent and fatal for one started by a webhook, because nobody is listening to answer. The symptom is an agent that emits its tool calls and goes idle having done nothing. Set `always_allow` explicitly.

**Vaulted secrets reach headers and bodies, never query strings.** If a service authenticates with `?key=...`, the placeholder goes out literally and you get its own auth error back. Check whether the service also accepts a header: Airbrake's documentation describes only the query parameter, and it accepts `Authorization: Bearer` perfectly well.

**A token authenticates as an identity, and everything it creates inherits that identity.** Our agent files issues with a repository-scoped token, and every issue it opens is attributed to the human who minted it. Nothing on the far side distinguishes agent-filed from person-filed. If that system is anyone's audit trail, the attribution your workflow carefully maintains is discarded at the boundary, so use a machine user or an app installation rather than a personal token. Deciding this after a hundred artifacts carry the wrong author is much more expensive than deciding it first.

**Scope the token explicitly; do not infer its grant from an API response.** GitHub returns a `permissions` block reporting the repository role of the *account* a token authenticates as, not the token's own grant. Ours read `admin: true` while the token could do nothing but file issues. Read it as a warning about what a loosely scoped token would inherit, never as evidence of what this one can do. The only test of a write scope is a write.

**Egress is a shared address, so unauthenticated calls are unreliable.** A rate limit keyed to the source address is spent by traffic that is not yours. We designed a visibility probe around an unauthenticated `404` and got `403 rate limit exceeded` instead, which proved nothing in either direction. Authenticate every call, including the ones that are only meant to establish a baseline.

**Only the production alias is public.** Deployment-specific URLs sit behind platform authentication, which answers with a 401 that looks exactly like this relay's own rejection. Use the alias, and read the body before assuming the signature check ran.

## One session per run

A run gets one agent session for its life, and every delivery for that run is sent into it: an assignment, an approval, a rejection, a comment. The agent stays on the run rather than being invoked per step, so it remembers what it already read and already decided.

This is also what stops the same work being done twice, which matters more than the continuity.

**Manifestly's hook mechanism reports what happened. Scoping work and managing concurrency are yours.** That is a deliberate division and a reasonable one, but it means something concrete here: one step can produce several deliveries. An assignment and an applicability change are different facts about the same step, a step can become applicable more than once, and nothing in the delivery tells you another delivery for the same work is in flight. We have had a step produce two deliveries half an hour apart, with two sessions each working the whole thing and every outbound action taken twice. Nothing was corrupted only because the one write involved happened to be idempotent.

The session pointer is this relay's answer: every delivery for a run resolves to one session, so a second delivery is a message to the agent already on the job rather than a second agent.

**It needs the two Upstash variables, and without them you are opting out of that.** The relay logs `session_store_unconfigured` and falls back to one session per delivery, which is the behaviour described above. It still runs, and it costs more, but the thing you lose is the protection rather than a convenience. `CLAUDE.md` has the reasoning and the failure modes.

## What it deliberately does not do

Nothing about your process. No retries of its own, no business logic, no knowledge of what the agent is for. Everything describing the work lives in your workflow's step text.

## Keeping your copy current

You own your copy, so nothing here updates itself. Configuration is entirely environment variables and there is no code you need to change, which means a fork does not drift and pulling updates stays clean:

```
git remote add upstream https://github.com/Manifestly/manifestly-agent-relay
git fetch upstream && git merge upstream/main
```

Worth doing occasionally rather than never. This has shipped correctness fixes that a copy taken beforehand does not have, and the relay cannot tell you it is missing one. `CHANGELOG.md` lists behaviour changes, so you can tell in a few seconds whether yours matters.

## Tests

```
npm test
```

The signature tests are the ones that matter, since that is the only line here that must not be wrong. They pin the HMAC arithmetic against a digest computed by `openssl` rather than by this code, so they assert agreement between two implementations rather than with themselves.

They do **not** prove that a real delivery verifies, because Manifestly signs JSON-canonicalized bytes and the fixtures are strings written by hand. There is a `todo` test marking that gap; fill it with a captured delivery. Production has since verified real deliveries, so the canonicalization is right in practice and still unpinned in the suite.
