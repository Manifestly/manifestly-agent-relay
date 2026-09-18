import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Manifestly signs the exact bytes it sends, which are JSON canonicalization
 * (`to_json_c14n`) output. Verify against the raw request body: parsing the
 * JSON and re-serializing it in JS will not reproduce those bytes, and every
 * real delivery will fail to verify while hand-built fixtures pass.
 */
export function signatureIsValid(rawBody, header, secret) {
  if (!secret) return false;
  if (typeof header !== "string" || !header.startsWith(PREFIX)) return false;

  const received = header.slice(PREFIX.length);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // timingSafeEqual throws on a length mismatch, so this guard comes first.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/** Exported for the temporary rejection diagnostics in the handler. */
export function expectedDigest(rawBody, secret) {
  return createHmac("sha256", secret || "").update(rawBody).digest("hex");
}
