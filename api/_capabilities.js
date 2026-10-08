import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * capabilities.yaml: what this deployment lets the agent reach.
 *
 * Deliberately provider-agnostic, including the names. `sandbox: none | hosted`
 * is not either provider's vocabulary: OpenAI takes `environment: {type}`
 * inline per session and genuinely has a "none", while Anthropic's
 * `environment_id` is required and names a persisted account object, so there
 * is no "none" to ask for and the equivalent is an environment with no egress.
 * Writing the config in either provider's terms would have made the other one
 * a special case in a file that is supposed to describe intent.
 *
 * Absent is valid and is the safe configuration: MCP servers only, no shell,
 * no egress. A template that requires a file before it runs is a template that
 * does not run.
 */
const path = new URL("../capabilities.yaml", import.meta.url);
const source = existsSync(path) ? parse(readFileSync(path, "utf8")) ?? {} : {};

const SANDBOX = ["none", "hosted"];

function sandboxFrom(value) {
  const sandbox = value ?? "none";
  if (!SANDBOX.includes(sandbox)) {
    throw new Error(`capabilities.yaml: sandbox "${sandbox}" is not one of: ${SANDBOX.join(", ")}`);
  }
  return sandbox;
}

export const sandbox = sandboxFrom(source.sandbox);

/** True when the agent gets a container, and therefore a shell. */
export const hasSandbox = sandbox === "hosted";

export const secrets = Object.freeze(
  (source.secrets ?? []).map((secret, index) => {
    if (!secret?.name) throw new Error(`capabilities.yaml: secrets[${index}] has no name`);
    if (!secret.hosts?.length) {
      // A secret with no hosts is injected nowhere, so the agent holds a
      // placeholder and every authenticated call fails as if the credential
      // were wrong rather than unscoped.
      throw new Error(`capabilities.yaml: secret "${secret.name}" names no hosts`);
    }
    return Object.freeze({ name: secret.name, hosts: Object.freeze([...secret.hosts]) });
  }),
);

/**
 * Every host the agent may reach: the ones declared for their own sake plus
 * the ones implied by a secret, since a secret the agent cannot reach the host
 * for is useless. Derived here rather than in a provider adapter so both see
 * the same answer.
 */
export const egress = Object.freeze([
  ...new Set([...(source.egress ?? []), ...secrets.flatMap((secret) => secret.hosts)]),
]);

/**
 * Declaring egress without a sandbox is almost always a mistake worth naming:
 * with no shell there is nothing to make the request from, so the hosts are
 * inert and the deployment does not do what its config says it does.
 */
export function inertEgress() {
  return hasSandbox ? [] : egress;
}
