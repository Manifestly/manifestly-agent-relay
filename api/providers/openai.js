import OpenAI from "openai";
import { instructions, mcpServers } from "../_agent_definition.js";
import { hasSandbox } from "../_capabilities.js";
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
 * This provider's translation of "every declared server, with permission
 * pre-granted", which is what agent.yaml says neutrally.
 *
 * `required: true` is the load-bearing part. It defaults to false, which
 * silently drops a server that will not connect: the turn then completes and
 * the agent writes a confident answer saying it has no tools, with no error
 * anywhere. Observed. It is this provider's equivalent of Anthropic needing
 * always_allow, and for the same reason -- nobody is listening to intervene.
 */
function tools() {
  return mcpServers.map((server) => ({
    type: "mcp",
    server_label: server.name,
    transport: { type: "http", server_url: server.url },
    required: true,
    // Documented as the default. Pinned because the alternative origin is an
    // execution environment, which does not exist under `sandbox: none`.
    connection_origin: "service",
  }));
}

/**
 * `sandbox` from capabilities.yaml, in this provider's vocabulary.
 *
 * Here it is an inline per-session field and "none" is real, which is why the
 * neutral config does not borrow Anthropic's environment_id shape: that is a
 * required id naming a persisted account object, so the same intent has to be
 * expressed there by what the environment permits rather than by asking for
 * nothing. Translating in both adapters is cheaper than one config pretending
 * the two APIs agree.
 */
function environment() {
  return { type: hasSandbox ? "openai_hosted" : "none" };
}

/**
 * Unlike Anthropic, which takes a persisted agent id, OpenAI takes the whole
 * definition on every create. agent.yaml is the one source for both.
 */
function agentDefinition() {
  return { model: requiredEnv("AGENT_MODEL"), instructions, tools: tools() };
}

export async function createSession({ runId, brief }) {
  const session = await openai().beta.agents.sessions.create({
    agent: agentDefinition(),
    environment: environment(),
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
