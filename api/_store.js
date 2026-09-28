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
};
