/**
 * The one piece of state this relay holds, and the reason it is not a violation
 * of the statelessness the rest of the design leans on.
 *
 * The Run records what work happened. This records that a process is currently
 * working, which is a different fact with a different lifetime: true for
 * minutes, and wrong the moment a session dies. That does not belong on a Run,
 * and a short-TTL key is what makes a crashed session self-healing rather than
 * a permanently stuck run.
 *
 * Reached over Upstash's REST API rather than a Redis socket because this runs
 * in a serverless function, where a connection per invocation is the wrong
 * shape.
 */
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export function storeIsConfigured() {
  return Boolean(url && token);
}

async function command(...args) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`upstash ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()).result;
}

export const store = {
  async setIfAbsent(key, value, ttlSeconds) {
    return (await command("SET", key, value, "NX", "EX", ttlSeconds)) === "OK";
  },
  async get(key) {
    return (await command("GET", key)) ?? null;
  },
  async set(key, value, ttlSeconds) {
    await command("SET", key, value, "EX", ttlSeconds);
  },
  async release(key) {
    await command("DEL", key);
  },
};
