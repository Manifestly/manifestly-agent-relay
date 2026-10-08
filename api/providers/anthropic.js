import Anthropic from "@anthropic-ai/sdk";
import { name as agentName, description, instructions, mcpServers, providerSection } from "../_agent_definition.js";
import { requiredEnv } from "../_config.js";

/**
 * Everything this relay knows about Anthropic, and the only file that does.
 *
 * The seam is two calls and one predicate. The orchestration around them --
 * single flight, the run-and-agent pointer, the deferral -- is a statement
 * about Manifestly's delivery contract rather than about any provider, and
 * stays in _session.js where it belongs.
 */
export const name = "anthropic";

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

/**
 * The body POST /v1/agents expects, rendered from agent.yaml.
 *
 * Unused at session create, because this provider runs a persisted agent named
 * by ANTHROPIC_AGENT_ID. bin/agent-json prints this and bin/agent-apply PUTs
 * it, which is what keeps the live agent equal to the checked-in file. It lives
 * here rather than in _agent_definition.js because the shape is Anthropic's.
 */
export function agentDefinition() {
  const { model, tools } = providerSection(name);

  return {
    name: agentName,
    description,
    model,
    system: instructions,
    mcp_servers: mcpServers.map((server) => ({ ...server })),
    tools,
  };
}

export async function createSession({ runId, brief }) {
  const session = await anthropic().beta.sessions.create({
    agent: requiredEnv("ANTHROPIC_AGENT_ID"),
    environment_id: requiredEnv("ANTHROPIC_ENVIRONMENT_ID"),
    vault_ids: [requiredEnv("ANTHROPIC_VAULT_ID")],
    title: `Manifestly run ${runId}`,
    metadata: { manifestly_run_id: String(runId) },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: brief }] }],
  });

  return { id: session.id };
}

// Sending into a session that is mid-turn is not an error: the platform queues
// the input and delivers it when the turn ends. That is what makes one session
// per run possible at all, and it is why nothing here checks session status.
export async function sendToSession(sessionId, { brief }) {
  return anthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: brief }] }],
  });
}

/**
 * Whether a failed send means "this session cannot accept input again", in
 * which case the pointer is stale and the run needs a new session.
 *
 * An allowlist rather than a denylist, so anything unrecognised is rethrown and
 * retried. Only 404 was handled first, which would have left an archived or
 * terminated session failing every delivery for the rest of the run. Auth
 * failures, throttling and server errors say nothing about the session, and
 * recreating on them would answer a missing key or a rate limit by starting a
 * second session for the run.
 *
 * These statuses are this provider's, not a shared truth. Another provider's
 * list is its own, and copying this one across would treat a status that means
 * something else as a dead session.
 */
export function sessionCannotAcceptInput(error) {
  return [400, 404, 409, 410].includes(error?.status);
}
