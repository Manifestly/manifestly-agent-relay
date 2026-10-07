import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";

/**
 * A deployment is coupled to one provider, chosen by AGENT_PROVIDER.
 *
 * Not per delivery, because nothing in the delivery says which provider should
 * run it and nothing should: an AiAgent points at a hook URL, and whoever
 * operates that endpoint chooses what is behind it. Manifestly stays blind to
 * the question, which is the property that lets a customer run their own relay
 * on their own account without telling us anything.
 *
 * Per deployment also means the Upstash instance is per provider, so session
 * pointers cannot collide across providers without any key doing that work.
 */
const PROVIDERS = { anthropic, openai };

export function provider() {
  const name = process.env.AGENT_PROVIDER?.trim() || "anthropic";
  const selected = PROVIDERS[name];

  // Failing at boot beats a deployment that silently runs the wrong provider,
  // or one that defaults to a provider whose credentials are not configured.
  if (!selected) {
    throw new Error(`AGENT_PROVIDER "${name}" is not one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }

  return selected;
}
