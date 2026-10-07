import OpenAI from "openai";
import { instructions, manifestlyMcpUrl } from "../_agent_definition.js";

/**
 * Everything this relay knows about OpenAI, and the only file that does.
 *
 * Shapes here were established against the live API rather than from the docs,
 * which are wrong in at least one load-bearing place: the create response field
 * is `id`, not the documented `session_id`.
 */
export const name = "openai";

// The Agents API is the Codex harness and refuses general models: gpt-5 is
// rejected outright. Model validation also runs BEFORE the permission check,
// so a bad model produces a 400 that looks like the credentials are fine.
const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-6-astra";

let client;
function openai() {
  client ??= new OpenAI();
  return client;
}

// Unlike Anthropic, which takes a persisted agent id, OpenAI takes the whole
// definition on every create. agent.yaml is still the one source for both.
function agentDefinition() {
  return {
    model: MODEL,
    instructions,
    tools: [
      {
        type: "mcp",
        server_label: "manifestly",
        transport: { type: "http", server_url: manifestlyMcpUrl },
        // Defaults to false, which silently drops a server that will not
        // connect. The turn then completes and the agent writes a confident
        // answer saying it has no tools, with no error anywhere. Observed.
        required: true,
        // Documented as the default, pinned because environment is "none" and
        // the alternative origin is an execution environment that will not exist.
        connection_origin: "service",
      },
    ],
  };
}

export async function createSession({ runId, brief }) {
  const session = await openai().beta.agents.sessions.create({
    agent: agentDefinition(),
    // No sandbox. This agent only calls a remote MCP server, and a hosted
    // environment is a second thing that can fail to provision: the one
    // earlier attempt at this died with "The sandbox failed to connect".
    environment: { type: "none" },
    vault_ids: [process.env.OPENAI_VAULT_ID],
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
