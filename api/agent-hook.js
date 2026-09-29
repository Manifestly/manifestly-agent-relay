import Anthropic from "@anthropic-ai/sdk";
import { signatureIsValid } from "./_signature.js";
import { resolveSession, runSessionKey, createLockKey, sessionCannotAcceptInput } from "./_session.js";
import { store, storeIsConfigured } from "./_store.js";

// Deliberately not an allowlist of event names. An agent hook receives only
// agent-work notifications, and which name arrives depends on how the step was
// assigned: step_assigned / step_became_applicable for a membership,
// step_role_ready for a multi-member role, run_invited when the agent joins the
// run as a participant. Enumerating them got this wrong twice, silently, so the
// condition is instead "does this delivery name a run" and the agent works out
// what is waiting for it from the run state, which its system prompt already
// tells it to do.

// Held only across sessions.create, which is one API call. Two minutes is
// generous for that and short enough that a crashed invocation costs one
// delivery rather than wedging the run.
const CREATE_LOCK_TTL_SECONDS = 120;

// The pointer has to outlive the run, not the delivery. Runs in this workflow
// finish within a day; the ones that stall waiting on a human approval are the
// reason this is measured in weeks. A pointer that outlives its run costs one
// stale key; a pointer that expires under its run costs a duplicate session,
// which is the thing this exists to prevent.
const SESSION_POINTER_TTL_SECONDS = 60 * 60 * 24 * 14;

const POINTER_WAIT_ATTEMPTS = 8;
const POINTER_WAIT_MS = 250;

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

  const outcome = await deliverToRun(delivery);

  if (outcome.defer) {
    // A 503 rather than a 204: this delivery has not been handled, and saying
    // so is what makes Manifestly's retry do the work. The old code returned
    // 204 here and the delivery was simply lost.
    console.log(JSON.stringify({
      diag: "deferred_to_retry",
      run_id: delivery.run_id,
      event: delivery.event,
      run_step_id: delivery.run_step_id ?? null,
    }));
    return new Response("session not yet available", { status: 503 });
  }

  return Response.json({ session_id: outcome.sessionId, resumed: outcome.resumed });
}

/**
 * Routes one delivery to its run's session, creating that session if this is
 * the first delivery for the run.
 *
 * `attempt` bounds the one recoverable failure: a pointer naming a session that
 * no longer exists, which resolves by forgetting it and creating a new one.
 */
async function deliverToRun(delivery, attempt = 0) {
  const runId = delivery.run_id;

  if (!storeIsConfigured()) {
    console.log(JSON.stringify({ diag: "session_store_unconfigured", run_id: runId }));
    return { sessionId: (await createSession(delivery)).id, resumed: false };
  }

  let resolution;
  try {
    resolution = await resolveSession(store, runId, {
      lockTtlSeconds: CREATE_LOCK_TTL_SECONDS,
      pointerAttempts: POINTER_WAIT_ATTEMPTS,
      pause: () => new Promise((resolve) => setTimeout(resolve, POINTER_WAIT_MS)),
    });
  } catch (error) {
    // An unreachable store must not stop the agent working. It degrades to a
    // session per delivery, which is what this whole design replaced, and says
    // so loudly rather than failing closed into silence.
    console.log(JSON.stringify({
      diag: "session_store_unavailable",
      run_id: runId,
      error: String(error).slice(0, 200),
    }));
    return { sessionId: (await createSession(delivery)).id, resumed: false };
  }

  if (resolution.action === "defer") return { defer: true };

  if (resolution.action === "send") {
    try {
      await sendToSession(resolution.sessionId, delivery);
      await refreshPointer(runId, resolution.sessionId);
      console.log(JSON.stringify({
        diag: "resumed_session",
        session_id: resolution.sessionId,
        run_id: runId,
        event: delivery.event,
        run_step_id: delivery.run_step_id ?? null,
      }));
      return { sessionId: resolution.sessionId, resumed: true };
    } catch (error) {
      if (!sessionCannotAcceptInput(error) || attempt > 0) throw error;
      console.log(JSON.stringify({
        diag: "session_pointer_stale",
        session_id: resolution.sessionId,
        run_id: runId,
        error: String(error).slice(0, 200),
      }));
      await forgetQuietly(runSessionKey(runId));
      return deliverToRun(delivery, attempt + 1);
    }
  }

  console.log(JSON.stringify({
    diag: "starting_session",
    event: delivery.event,
    run_id: runId,
    run_step_id: delivery.run_step_id ?? null,
  }));

  let session;
  try {
    session = await createSession(delivery);
  } catch (error) {
    // Holding the create lock for a session that does not exist would suppress
    // every delivery for the run until it expired, which is the window the
    // agent was meant to be working in.
    await forgetQuietly(createLockKey(runId));
    throw error;
  }

  await refreshPointer(runId, session.id);
  return { sessionId: session.id, resumed: false };
}

// Awaited rather than fired and forgotten: a failure here becomes a non-200,
// which is what makes Manifestly's delivery retry meaningful.
async function createSession(delivery) {
  return anthropic().beta.sessions.create({
    agent: process.env.CMA_AGENT_ID,
    environment_id: process.env.CMA_ENVIRONMENT_ID,
    vault_ids: [process.env.CMA_VAULT_ID],
    title: `Manifestly run ${delivery.run_id}`,
    metadata: { manifestly_run_id: String(delivery.run_id) },
    initial_events: [
      { type: "user.message", content: [{ type: "text", text: assignmentBrief(delivery, false) }] },
    ],
  });
}

// Sending into a session that is mid-turn is not an error: the platform queues
// the input and delivers it when the turn ends. That is what makes one session
// per run possible at all, and it is why nothing here checks session status.
async function sendToSession(sessionId, delivery) {
  return anthropic().beta.sessions.events.send(sessionId, {
    events: [
      { type: "user.message", content: [{ type: "text", text: assignmentBrief(delivery, true) }] },
    ],
  });
}

async function refreshPointer(runId, sessionId) {
  try {
    await store.set(runSessionKey(runId), sessionId, SESSION_POINTER_TTL_SECONDS);
  } catch (error) {
    // The session exists and has the work; failing the delivery now would
    // retry it into a second session, which is the duplicate this prevents.
    console.log(JSON.stringify({
      diag: "session_pointer_write_failed",
      run_id: runId,
      session_id: sessionId,
      error: String(error).slice(0, 200),
    }));
  }
}

async function forgetQuietly(key) {
  try {
    await store.release(key);
  } catch (error) {
    console.log(JSON.stringify({ diag: "key_release_failed", key, error: String(error).slice(0, 200) }));
  }
}

/**
 * The delivery carries ids and nothing else, by design. The agent reads the
 * run through the Manifestly MCP server at whatever freshness it needs, so
 * this brief says which run and says nothing about what the work is: that
 * lives in the workflow's own step instructions.
 */
function assignmentBrief(delivery, resumed) {
  return [
    resumed
      ? `More Manifestly work has arrived on a run you are already working (${delivery.event}).`
      : `Manifestly has work waiting for you (${delivery.event}).`,
    `run_id=${delivery.run_id}`,
    `run_step_id=${delivery.run_step_id ?? "(not specified, find your own assignments in the run)"}`,
    `department_id=${delivery.department_id}`,
    `Read the run through the Manifestly MCP server and complete the steps assigned to you.`,
    `Other deliveries for this run may have been folded into this session, so read the run's current state rather than assuming this event is all that is waiting.`,
  ].join("\n");
}
