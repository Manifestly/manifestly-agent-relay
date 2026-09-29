import { Redis } from "@upstash/redis";

/**
 * The one piece of state this relay holds, and the reason it is not a violation
 * of the statelessness the rest of the design leans on.
 *
 * The Run records what work happened. This records that a process is currently
 * working, which is a different fact with a different lifetime: true for
 * minutes, and wrong the moment a session dies. That does not belong on a Run,
 * and a short TTL is what makes a crashed session self-healing rather than a
 * permanently stuck run.
 */
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export function storeIsConfigured() {
  return Boolean(url && token);
}

let redis;
function client() {
  redis ??= new Redis({ url, token });
  return redis;
}

export const store = {
  // `nx` is the whole mechanism: of N simultaneous callers exactly one gets
  // "OK" back and the rest get null. Everything else here is bookkeeping.
  async setIfAbsent(key, value, ttlSeconds) {
    return (await client().set(key, value, { nx: true, ex: ttlSeconds })) === "OK";
  },
  async get(key) {
    return (await client().get(key)) ?? null;
  },
  async set(key, value, ttlSeconds) {
    await client().set(key, value, { ex: ttlSeconds });
  },
  async release(key) {
    await client().del(key);
  },
  // Compare-and-swap. Redis has no native CAS, and SET ... GET is not a
  // substitute: the loser of that race overwrites the value the winner just
  // recorded. Lua runs the whole comparison and write as one operation, so a
  // caller only wins if the key still holds exactly what it validated.
  async swapIfHolder(key, expected, value, ttlSeconds) {
    const swapped = await client().eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
        "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 " +
        "else return 0 end",
      [key],
      [expected, value, String(ttlSeconds)],
    );
    return swapped === 1;
  },
};
