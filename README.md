# Manifestly agent relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a [Claude Managed Agents](https://docs.claude.com/en/api/agent-sdk) session to do the work.

It is about forty lines. Manifestly cannot call the Anthropic API directly, because the delivery body and headers are Manifestly's own shape, so something has to sit between them. This is that something.

## What it does

1. Verifies the `X-Manifestly-Signature` header against the raw request body.
2. Logs and ignores any delivery that does not name a run.
3. Looks up the session that belongs to that run.
4. Sends the delivery into that session, or starts one if the run does not have one yet.
5. Returns 200 only if the delivery reached a session, so a failure is retried.

The delivery carries ids and nothing else. The agent reads the run through the Manifestly MCP server, which means the instructions for the work live in your workflow's step text, not in this code. Nothing here knows what process it triggered.

**It does not filter on event name, deliberately.** Which event you get depends on how the step was assigned: `step_assigned` or `step_became_applicable` for a step assigned to a membership, `step_role_ready` for a role with several members, `run_invited` when the agent joins the run as a participant. An earlier version listed the two it expected and silently ignored real deliveries twice, returning 204 and looking healthy. An agent hook only ever receives agent-work notifications, so the useful question is whether the delivery names a run.

## Deploy

```
npm install
npx vercel deploy --prod
```

Then set the environment variables from `.env.example` in the Vercel dashboard and redeploy.

## Setting it up

**In Manifestly.** Create an AI agent under Settings > Users, choosing the department the work lives in. Copy its API key on the creation screen; it is shown exactly once. Leave the endpoint URL blank for now.

Then take the webhook signing secret from Settings > Account. Two things to know about it: it is account-level rather than per-hook, and it is shown only when created or rotated. If nobody saved it, the only way to obtain it is to rotate, which invalidates it for every other webhook consumer in the account at the same moment. Check what else is subscribed before you rotate.

**In Anthropic.** Create a vault holding two credentials: a `static_bearer` keyed to your Manifestly MCP server URL, holding the agent's API key, and an `environment_variable` for any other service the agent needs to reach. Vaulted secrets are substituted at egress and never enter the agent's sandbox.

Create an environment, then an agent whose `mcp_servers` lists your Manifestly MCP server and whose `tools` includes a matching `mcp_toolset` entry. Keep the agent's system prompt free of any single process's details: it should say how the agent works, while each workflow's step text says what the work is. That is what lets one agent serve every workflow.

**Back in Manifestly.** Set this relay's URL as the agent's endpoint, then assign steps to the agent.

## Assigning steps, and the one trap

Assign the step to the agent's membership directly, or to a role with **exactly one member**.

A role resolves to a single member when it has one, and that is what makes the delivery fire. Add a second member, a human backup for holiday cover say, and the role stops resolving to a single membership, the webhook silently stops firing, and the run sits there with no error anywhere. Adding a person to a role looks additive and is not.

Roles are still worth using, because they are portable: a workflow exported as a template carries the role name, so whoever imports it maps their own agent. A membership id does not port.

## Things that cost us a day

**Set the environment variables from the CLI, not a dashboard.** Both secrets we pasted into Vercel's web form arrived truncated: a 32-character signing secret stored as 19, and an API key as a fragment. Neither failed at the time. They surfaced much later as unexplained 401s from two different systems. Verify the length before and after.

**Your agent's MCP tools probably default to asking permission.** On Claude Managed Agents, `mcp_toolset` defaults to `permission_policy: always_ask`, which suspends every call waiting for a confirmation event. That is right for an interactive agent and fatal for one started by a webhook, because nobody is listening to answer. The symptom is an agent that emits its tool calls and goes idle having done nothing. Set `always_allow` explicitly.

**Vaulted secrets reach headers and bodies, never query strings.** If a service authenticates with `?key=...`, the placeholder goes out literally and you get its own auth error back. Check whether the service also accepts a header: Airbrake's documentation describes only the query parameter, and it accepts `Authorization: Bearer` perfectly well.

**Only the production alias is public.** Deployment-specific URLs sit behind platform authentication, which answers with a 401 that looks exactly like this relay's own rejection. Use the alias, and read the body before assuming the signature check ran.

## What it deliberately does not do

**One session per run, for the life of the run.** The agent is a participant on a run, not a function invoked per step. It keeps one session while humans and other agents work that run alongside it, and every delivery -- an assignment, an approval, a rejection, a comment -- is sent into it. So the agent remembers within a run what it has already looked at and already decided, instead of rediscovering the run from nothing on each step.

Redis holds the run's session id. That pointer lives as long as the run; a separate short-lived key guards the one moment two deliveries could both create a session for a run that has none yet.

Deliveries arriving while the agent is mid-turn are not a problem to arbitrate: the platform queues an input sent into a running session and delivers it when the turn ends. Nothing here reads session status.

This needs the two Upstash variables. Without them the relay logs `session_store_unconfigured` and reverts to one session per delivery.

**Nothing about your process.** No retries of its own, no business logic, no knowledge of what the agent is for.

## Tests

```
npm test
```

The signature tests are the ones that matter, since that is the only line here that must not be wrong. They pin the HMAC arithmetic against a digest computed by `openssl` rather than by this code, so they assert agreement between two implementations rather than with themselves.

They do **not** prove that a real delivery verifies, because Manifestly signs JSON-canonicalized bytes and the fixtures are strings written by hand. There is a `todo` test marking that gap; fill it with a captured delivery. Production has since verified real deliveries, so the canonicalization is right in practice and still unpinned in the suite.
