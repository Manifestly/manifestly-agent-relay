export const CREATING = "creating";

export function runSessionKey(runId) {
  return `agent:run:${runId}:session`;
}

export function createLockKey(runId) {
  return `agent:run:${runId}:creating`;
}

/**
 * A run has one session, and every delivery for that run reaches it.
 *
 * What this replaces spent most of its length arbitrating between competing
 * sessions: whether to suppress a delivery, whether an idle holder could be
 * taken over, who won that takeover. None of that is needed once a run has a
 * single session, because deliveries no longer compete. Inputs sent while the
 * agent is mid-turn are queued by the platform and delivered when the turn
 * ends, so two deliveries landing together both reach the agent rather than one
 * of them being dropped as a duplicate.
 *
 * Two keys, because the single key this grew out of was doing two jobs whose
 * lifetimes are incompatible. A lock has to expire on its own or one crashed
 * invocation wedges the run until someone notices. A pointer must not expire on
 * that timescale: the session outlives any one delivery, and an hour-long
 * pointer is exactly why a run whose steps complete over a morning accumulated
 * a session per step.
 */
export async function resolveSession(store, runId, options) {
  const { lockTtlSeconds, pointerAttempts, pause } = options;
  const pointerKey = runSessionKey(runId);

  const existing = await store.get(pointerKey);
  if (existing !== null) return { action: "send", sessionId: existing };

  if (await store.setIfAbsent(createLockKey(runId), CREATING, lockTtlSeconds)) {
    return { action: "create" };
  }

  // Another invocation is creating the session and will publish the pointer
  // within a second or two. Waiting for it is cheaper and far faster than
  // declining the delivery and waiting for Manifestly to redeliver, and unlike
  // the old suppression it does not discard the delivery to get there.
  for (let attempt = 0; attempt < pointerAttempts; attempt += 1) {
    await pause();
    const published = await store.get(pointerKey);
    if (published !== null) return { action: "send", sessionId: published };
  }

  return { action: "defer" };
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
 */
export function sessionCannotAcceptInput(error) {
  return [400, 404, 409, 410].includes(error?.status);
}
