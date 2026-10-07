export const CREATING = "creating";

export function runSessionKey(runId, agentId) {
  return `agent:run:${runId}:agent:${agentId}:session`;
}

export function createLockKey(runId, agentId) {
  return `agent:run:${runId}:agent:${agentId}:creating`;
}

/**
 * A run has one session PER AGENT, and every delivery for that pair reaches it.
 *
 * Keyed on the pair rather than the run because a run can have steps assigned to
 * more than one agent, and each is a separate worker with its own continuous
 * context. Keyed on the run alone, the second agent's delivery finds the first
 * agent's pointer and sends its work into a session belonging to someone else:
 * an agent is told to do work it was not assigned, and the session that was
 * supposed to receive it never hears about it. Where a relay serves agents
 * belonging to different parties, that is a leak rather than a mix-up.
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
export async function resolveSession(store, runId, agentId, options) {
  const { lockTtlSeconds, pointerAttempts, pause } = options;
  const pointerKey = runSessionKey(runId, agentId);

  const existing = await store.get(pointerKey);
  if (existing !== null) return { action: "send", sessionId: existing };

  if (await store.setIfAbsent(createLockKey(runId, agentId), CREATING, lockTtlSeconds)) {
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
