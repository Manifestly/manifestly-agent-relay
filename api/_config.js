/**
 * Every environment variable this relay reads, in one list.
 *
 * It was previously spread across four files, which made two questions
 * unanswerable without grepping: what does this deployment need, and what is
 * missing right now. A missing CMA_AGENT_ID surfaced as a provider API error on
 * the first real delivery, which reads as a code fault.
 *
 * The division of labour with agent.yaml is the point. agent.yaml holds what
 * the agent IS: prompt, model, tools, servers. Those are the same for everyone
 * who runs this relay, so they are checked in. This file holds only what is
 * secret or specific to one account, which is exactly what a template repo must
 * not contain. If something here would be identical for every deployment, it
 * belongs in agent.yaml instead.
 */

// Old names, still read so an existing deployment keeps working across the
// rename. CMA said nothing a reader could connect to AGENT_PROVIDER=anthropic.
const DEPRECATED = {
  ANTHROPIC_AGENT_ID: "CMA_AGENT_ID",
  ANTHROPIC_ENVIRONMENT_ID: "CMA_ENVIRONMENT_ID",
  ANTHROPIC_VAULT_ID: "CMA_VAULT_ID",
};

const SHARED = [
  { name: "MANIFESTLY_WEBHOOK_SIGNING_SECRET", why: "verifies every delivery; without it the relay rejects all of them" },
];

const BY_PROVIDER = {
  anthropic: [
    { name: "ANTHROPIC_API_KEY", why: "creates sessions" },
    { name: "ANTHROPIC_AGENT_ID", why: "the persisted agent every session runs" },
    { name: "ANTHROPIC_ENVIRONMENT_ID", why: "the environment every session runs in" },
    { name: "ANTHROPIC_VAULT_ID", why: "holds the agent's credentials; attachable only at create" },
  ],
  openai: [
    { name: "OPENAI_API_KEY", why: "creates sessions; needs Agents, Vaults and Responses write" },
    { name: "AGENT_MODEL", why: "the model sessions run, named the way this provider names it" },
    { name: "OPENAI_VAULT_ID", why: "holds the agent's Manifestly bearer; attachable only at create" },
  ],
};

// Not required. The relay runs without them and says so, degrading to one
// session per delivery, which is the behaviour one-session-per-run replaces.
const OPTIONAL = [
  { name: "AGENT_PROVIDER", why: "which provider this deployment runs; defaults to anthropic" },
  { name: "AGENT_SANDBOX", why: "none or hosted; whether the agent gets a shell. Defaults to none" },
  { name: "AGENT_EFFORT", why: "how hard the model works per turn, the second cost knob after allowed_tools. anthropic: low|medium|high|xhigh|max, default high. openai: none|minimal|low|medium|high|xhigh|max, default the API's" },
  { name: "AGENT_MODEL", why: "on anthropic this is needed only by bin/agent-apply, since sessions run a persisted agent that already carries its model" },
  { name: "KV_REST_API_URL", why: "session store; or UPSTASH_REDIS_REST_URL" },
  { name: "KV_REST_API_TOKEN", why: "session store; or UPSTASH_REDIS_REST_TOKEN" },
];

export function env(name) {
  const value = process.env[name]?.trim();
  if (value) return value;

  const old = DEPRECATED[name];
  return old ? process.env[old]?.trim() || undefined : undefined;
}

/**
 * Reads a variable that must be set, naming what it is for when it is not.
 * Called at the point of use rather than at module load, so a deployment
 * missing one variable still answers the signature check and still logs.
 */
export function requiredEnv(name) {
  const value = env(name);
  if (value) return value;

  const why = [...SHARED, ...Object.values(BY_PROVIDER).flat()].find((entry) => entry.name === name)?.why;
  throw new Error(`${name} is not set${why ? ` (${why})` : ""}`);
}

/** What this deployment is missing for the provider it says it runs. */
export function missingFor(providerName) {
  return [...SHARED, ...(BY_PROVIDER[providerName] ?? [])]
    .filter((entry) => !env(entry.name))
    .map((entry) => entry.name);
}

/** Old names still in use, so the rename can be finished without guessing. */
export function deprecatedNamesInUse() {
  return Object.entries(DEPRECATED)
    .filter(([current, old]) => !process.env[current]?.trim() && process.env[old]?.trim())
    .map(([current, old]) => `${old} -> ${current}`);
}

export const configuration = Object.freeze({ SHARED, BY_PROVIDER, OPTIONAL, DEPRECATED });
