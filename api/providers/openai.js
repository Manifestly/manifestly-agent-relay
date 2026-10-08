import OpenAI from "openai";
import { instructions, mcpServer, providerSection } from "../_agent_definition.js";
import { requiredEnv } from "../_config.js";

/**
 * Everything this relay knows about OpenAI, and the only file that does.
 *
 * Shapes here were established against the live API rather than from the docs,
 * which are wrong in at least one load-bearing place: the create response field
 * is `id`, not the documented `session_id`.
 */
export const name = "openai";

let client;
function openai() {
  client ??= new OpenAI();
  return client;
}

/**
 * An agent.yaml tool entry as the Agents API wants it.
 *
 * Only the server reference is translated. Everything else on the entry passes
 * through untouched, so a flag this file has never heard of can be set in
 * agent.yaml without editing code -- which is the point of the tools list
 * living there. `required` and `connection_origin` are the two that matter
 * today and agent.yaml carries the reasoning for both.
 */
function toolFor({ mcp_server_name, ...rest }) {
  if (!mcp_server_name) return rest;

  const server = mcpServer(mcp_server_name);
  return {
    ...rest,
    server_label: server.name,
    transport: { type: "http", server_url: server.url },
  };
}

/**
 * Unlike Anthropic, which takes a persisted agent id, OpenAI takes the whole
 * definition on every create. agent.yaml is the one source for both, so the
 * model and the tools here are the file's rather than this file's.
 */
function agentDefinition() {
  const { model, tools } = providerSection(name);

  return { model, instructions, tools: tools.map(toolFor) };
}

export async function createSession({ runId, brief }) {
  const session = await openai().beta.agents.sessions.create({
    agent: agentDefinition(),
    // Configured in agent.yaml, which carries why it is "none" today and what
    // changing it costs. Not an env var: it describes the agent, and it would
    // be the same value for everyone running this relay unchanged.
    environment: providerSection(name).environment,
    vault_ids: [requiredEnv("OPENAI_VAULT_ID")],
    metadata: { manifestly_run_id: String(runId) },
    input: brief,
  });

  // The docs say session_id. The API says id.
  return { id: session.id ?? session.session_id };
}

// Input arriving mid-turn is absorbed into that turn rather than replacing it:
// the second message shares the running turn's id and the agent answers both.
// That is what makes one session per run work here as it does for Anthropic.
export async function sendToSession(sessionId, { brief }) {
  return openai().beta.agents.sessions.events.create(sessionId, {
    events: [
      {
        type: "agent.session.input.message",
        input: [{ role: "user", type: "message", content: [{ type: "input_text", text: brief }] }],
      },
    ],
  });
}

/**
 * This provider's list, which is NOT the Anthropic one. Observed:
 *
 *   404  an id that never existed, and one deleted out from under us
 *   409  a session that exists but can never run again
 *
 * The 409 is the one that matters. Omitting it would rethrow, Manifestly would
 * retry, and every retry would hit the same permanently dead session until the
 * retries exhausted: the run never worked and nothing saying why.
 *
 * 409 is not used for a turn already running. Sending into a live turn returns
 * a clean accept, which is why that case is absent here.
 */
export function sessionCannotAcceptInput(error) {
  return [404, 409].includes(error?.status);
}
