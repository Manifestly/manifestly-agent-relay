export const PENDING = "pending";

export function runClaimKey(runId) {
  return `agent:run:${runId}`;
}

/**
 * Decides whether this delivery should start a session for its run.
 *
 * Several deliveries can name one run within milliseconds: a rejection reopens
 * N steps, an approval unblocks a section, a comment arrives while either is in
 * flight. Each used to create its own session, and three concurrent sessions
 * planning the same work is how one step nearly produced fifteen GitHub issues.
 *
 * Suppressing a delivery loses nothing, which is what makes this safe. The
 * webhook payload carries ids only and the agent reads live run state through
 * MCP, so the surviving session sees everything the suppressed ones pointed at.
 *
 * `store.setIfAbsent` must be atomic (Redis SET NX EX). That is the whole
 * mechanism: of N simultaneous callers exactly one gets true, and the losers
 * then ask what the winner produced rather than guessing from timing.
 */
export async function claimRun(store, runId, ttlSeconds, isSessionRunning) {
  const key = runClaimKey(runId);

  if (await store.setIfAbsent(key, PENDING, ttlSeconds)) {
    return { proceed: true, takeover: false };
  }

  const holder = await store.get(key);

  if (holder === null) {
    // Expired between our SET and this GET. One retry, then treat a second
    // failure as a genuine race rather than looping.
    if (await store.setIfAbsent(key, PENDING, ttlSeconds)) {
      return { proceed: true, takeover: false };
    }
    return { proceed: false, reason: "raced_after_expiry", holder: await store.get(key) };
  }

  if (holder === PENDING) {
    return { proceed: false, reason: "session_being_created", holder };
  }

  // Sessions start idle, go running, and stay idle forever once the agent stops,
  // because nothing terminates a session started by a fire-and-forget webhook.
  // So "still working" is the only condition worth suppressing on; anything else
  // means this delivery deserves a session of its own.
  if (await isSessionRunning(holder)) {
    return { proceed: false, reason: "session_running", holder };
  }

  // Taking over has to be atomic for the same reason claiming does, and the
  // first version of this was not: two deliveries landing in the same second
  // both read the holder, both found it idle, and both returned proceed. That
  // is the bug this whole module exists to prevent, reintroduced one branch
  // further down, and it fired on the first unattended run.
  //
  // Compare-and-swap, so only the caller that actually replaces the holder it
  // validated goes on to create a session.
  if (await store.swapIfHolder(key, holder, PENDING, ttlSeconds)) {
    return { proceed: true, takeover: true, previous: holder };
  }

  return { proceed: false, reason: "lost_takeover_race", holder };
}
