import Anthropic from "@anthropic-ai/sdk";
import { signatureIsValid } from "./_signature.js";
import { claimRun, runClaimKey } from "./_claim.js";
import { store, storeIsConfigured } from "./_store.js";

// Deliberately not an allowlist of event names. An agent hook receives only
// agent-work notifications, and which name arrives depends on how the step was
// assigned: step_assigned / step_became_applicable for a membership,
// step_role_ready for a multi-member role, run_invited when the agent joins the
// run as a participant. Enumerating them got this wrong twice, silently, so the
// condition is instead "does this delivery name a run" and the agent works out
// what is waiting for it from the run state, which its system prompt already
// tells it to do.

// A backstop rather than the mechanism: while a session id is held, its status
// decides, so this only bounds how long a key outlives the thing it describes.
// It has to outlive the gap between creating a session and it reporting
// running, which is seconds. An hour is provisional and the suppression log is
// what will replace it with a measured value.
const CLAIM_TTL_SECONDS = 3600;

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

async function sessionIsRunning(sessionId) {
  const session = await anthropic().beta.sessions.retrieve(sessionId);
  return session.status === "running";
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

  const claim = await claimForDelivery(delivery);
  if (!claim.proceed) {
    console.log(JSON.stringify({
      diag: "suppressed_duplicate",
      reason: claim.reason,
      run_id: delivery.run_id,
      event: delivery.event,
      run_step_id: delivery.run_step_id ?? null,
      holder: claim.holder ?? null,
    }));
    return new Response(null, { status: 204 });
  }

  console.log(JSON.stringify({
    diag: "starting_session",
    event: delivery.event,
    run_id: delivery.run_id,
    run_step_id: delivery.run_step_id ?? null,
    takeover_of: claim.previous ?? null,
    claimed: claim.claimed,
  }));

  let session;
  try {
    // Awaited rather than fired and forgotten: a failure here becomes a non-200,
    // which is what makes Manifestly's delivery retry meaningful.
    session = await anthropic().beta.sessions.create({
      agent: process.env.CMA_AGENT_ID,
      environment_id: process.env.CMA_ENVIRONMENT_ID,
      vault_ids: [process.env.CMA_VAULT_ID],
      title: `Manifestly run ${delivery.run_id} step ${delivery.run_step_id}`,
      metadata: { manifestly_run_id: String(delivery.run_id) },
      initial_events: [
        { type: "user.message", content: [{ type: "text", text: assignmentBrief(delivery) }] },
      ],
    });
  } catch (error) {
    // Without this the run is suppressed for the whole TTL by a claim held for
    // a session that does not exist, which is the window the agent was meant to
    // be working in.
    if (claim.claimed) await releaseQuietly(delivery.run_id);
    throw error;
  }

  if (claim.claimed) {
    await recordQuietly(delivery.run_id, session.id);
  }

  return Response.json({ session_id: session.id });
}

/**
 * The claim prevents duplicate work; it is not a safety gate, and the
 * difference decides how it fails. Suppressing on an unreachable store would
 * silently stop the agent running at all, which is worse than the duplicate
 * sessions we have today. So an unavailable store degrades to the old
 * behaviour and says so loudly, rather than failing closed into silence.
 *
 * Duplicate external writes are the real hazard, and the durable answer to
 * those is idempotency at the action, not only at the trigger.
 */
async function claimForDelivery(delivery) {
  if (!storeIsConfigured()) {
    console.log(JSON.stringify({ diag: "claim_store_unconfigured", run_id: delivery.run_id }));
    return { proceed: true, claimed: false };
  }
  try {
    const claim = await claimRun(store, delivery.run_id, CLAIM_TTL_SECONDS, sessionIsRunning);
    return { ...claim, claimed: claim.proceed };
  } catch (error) {
    console.log(JSON.stringify({
      diag: "claim_store_unavailable",
      run_id: delivery.run_id,
      error: String(error).slice(0, 200),
    }));
    return { proceed: true, claimed: false };
  }
}

async function recordQuietly(runId, sessionId) {
  try {
    await store.set(runClaimKey(runId), sessionId, CLAIM_TTL_SECONDS);
  } catch (error) {
    // The session exists and is doing the work; failing the delivery now would
    // retry it and produce the duplicate this whole path exists to avoid.
    console.log(JSON.stringify({ diag: "claim_record_failed", run_id: runId, session_id: sessionId, error: String(error).slice(0, 200) }));
  }
}

async function releaseQuietly(runId) {
  try {
    await store.release(runClaimKey(runId));
  } catch (error) {
    console.log(JSON.stringify({ diag: "claim_release_failed", run_id: runId, error: String(error).slice(0, 200) }));
  }
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
    `Other deliveries for this run may have been folded into this session, so read the run's current state rather than assuming this event is all that is waiting.`,
  ].join("\n");
}
