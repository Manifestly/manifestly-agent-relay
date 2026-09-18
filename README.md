# Manifestly agent relay

Receives the webhook Manifestly sends when a run step is assigned to an AI agent, and starts a [Claude Managed Agents](https://docs.claude.com/en/api/agent-sdk) session to do the work.

It is about forty lines. Manifestly cannot call the Anthropic API directly, because the delivery body and headers are Manifestly's own shape, so something has to sit between them. This is that something.

## What it does

1. Verifies the `X-Manifestly-Signature` header against the raw request body.
2. Ignores any event other than `step_assigned` and `step_became_applicable`.
3. Starts a session of your configured agent, passing the run and step ids.
4. Returns 200 only if the session was created, so a failure is retried.

The delivery carries ids and nothing else. The agent reads the run through the Manifestly MCP server, which means the instructions for the work live in your workflow's step text, not in this code. Nothing here knows what process it triggered.

## Deploy

```
npm install
npx vercel deploy --prod
```

Then set the five environment variables from `.env.example` in the Vercel dashboard and redeploy.

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

## What it deliberately does not do

**No deduplication.** The body carries a `delivery_id` for exactly this purpose, but storing it needs a key-value store, and a duplicate costs one extra session whose agent finds the step already done. Add it if your volume makes that matter.

**Nothing about your process.** No retries of its own, no business logic, no knowledge of what the agent is for.

## Tests

```
npm test
```

The signature tests are the ones that matter, since that is the only line here that must not be wrong. They currently pin the HMAC arithmetic against a digest computed by `openssl` rather than by this code. They do **not** yet prove that a real delivery verifies, because Manifestly signs JSON-canonicalized bytes and the fixtures are strings written by hand. There is a `todo` test marking that gap; fill it with a captured delivery.
