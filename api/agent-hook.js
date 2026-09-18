import Anthropic from "@anthropic-ai/sdk";
import { signatureIsValid } from "./_signature.js";

const TRIGGERING_EVENTS = new Set(["step_assigned", "step_became_applicable"]);

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-manifestly-signature");

  if (!signatureIsValid(rawBody, signature, process.env.MANIFESTLY_WEBHOOK_SIGNING_SECRET)) {
    return new Response("invalid signature", { status: 401 });
  }

  const delivery = JSON.parse(rawBody);
  if (!TRIGGERING_EVENTS.has(delivery.event)) {
    return new Response(null, { status: 204 });
  }

  // Awaited rather than fired and forgotten: a failure here becomes a non-200,
  // which is what makes Manifestly's delivery retry meaningful.
  const session = await anthropic().beta.sessions.create({
    agent: process.env.CMA_AGENT_ID,
    environment_id: process.env.CMA_ENVIRONMENT_ID,
    vault_ids: [process.env.CMA_VAULT_ID],
    title: `Manifestly run ${delivery.run_id} step ${delivery.run_step_id}`,
    initial_events: [
      { type: "user.message", content: [{ type: "text", text: assignmentBrief(delivery) }] },
    ],
  });

  return Response.json({ session_id: session.id });
}

/**
 * The delivery carries ids and nothing else, by design. The agent reads the
 * run through the Manifestly MCP server at whatever freshness it needs, so
 * this brief says which run and says nothing about what the work is: that
 * lives in the workflow's own step instructions.
 */
function assignmentBrief(delivery) {
  return [
    `A Manifestly run step was assigned to you (${delivery.event}).`,
    `run_id=${delivery.run_id}`,
    `run_step_id=${delivery.run_step_id}`,
    `department_id=${delivery.department_id}`,
    `Read the run through the Manifestly MCP server and complete the steps assigned to you.`,
  ].join("\n");
}
