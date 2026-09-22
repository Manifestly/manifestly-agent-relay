import Anthropic from "@anthropic-ai/sdk";
import { signatureIsValid } from "./_signature.js";

// Deliberately not an allowlist of event names. An agent hook receives only
// agent-work notifications, and which name arrives depends on how the step was
// assigned: step_assigned / step_became_applicable for a membership,
// step_role_ready for a multi-member role, run_invited when the agent joins the
// run as a participant. Enumerating them got this wrong twice, silently, so the
// condition is instead "does this delivery name a run" and the agent works out
// what is waiting for it from the run state, which its system prompt already
// tells it to do.

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-manifestly-signature");

  if (!signatureIsValid(rawBody, signature, process.env.MANIFESTLY_WEBHOOK_SIGNING_SECRET)) {
    // A bare 401 is indistinguishable from a dozen other causes, including a
    // platform login page returning the same status. These three facts narrow
    // it without revealing anything: whether the body arrived, whether the
    // header arrived, and whether a secret is configured at all.
    console.log(JSON.stringify({
      diag: "signature_rejected",
      body_bytes: rawBody.length,
      header_present: signature !== null,
      secret_configured: Boolean(process.env.MANIFESTLY_WEBHOOK_SIGNING_SECRET),
    }));
    return new Response("invalid signature", { status: 401 });
  }

  const delivery = JSON.parse(rawBody);
  if (!delivery.run_id) {
    console.log(JSON.stringify({ diag: "no_run_id", event: delivery.event, keys: Object.keys(delivery) }));
    return new Response(null, { status: 204 });
  }
  console.log(JSON.stringify({ diag: "starting_session", event: delivery.event, run_id: delivery.run_id, run_step_id: delivery.run_step_id ?? null }));

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
    `Manifestly has work waiting for you (${delivery.event}).`,
    `run_id=${delivery.run_id}`,
    `run_step_id=${delivery.run_step_id ?? "(not specified, find your own assignments in the run)"}`,
    `department_id=${delivery.department_id}`,
    `Read the run through the Manifestly MCP server and complete the steps assigned to you.`,
  ].join("\n");
}
