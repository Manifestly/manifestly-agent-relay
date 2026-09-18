import { test } from "node:test";
import assert from "node:assert/strict";
import { signatureIsValid } from "../api/_signature.js";

// Computed with `openssl dgst -sha256 -hmac 'test-secret'` rather than with the
// code under test, so this asserts agreement between two implementations
// instead of agreement with itself.
const SECRET = "test-secret";
const BODY = '{"event":"step_assigned","run_id":1,"run_step_id":2}';
const DIGEST = "e1e8b790c90c0b4cce3df19f449b53f3ff0d24c7aed82d565e9a34f339359f7e";

test("accepts a correctly signed body", () => {
  assert.equal(signatureIsValid(BODY, `sha256=${DIGEST}`, SECRET), true);
});

test("rejects a body altered after signing", () => {
  const tampered = BODY.replace('"run_id":1', '"run_id":999');
  assert.equal(signatureIsValid(tampered, `sha256=${DIGEST}`, SECRET), false);
});

test("rejects a signature made with a different secret", () => {
  assert.equal(signatureIsValid(BODY, `sha256=${DIGEST}`, "other-secret"), false);
});

test("rejects a missing signature header", () => {
  assert.equal(signatureIsValid(BODY, null, SECRET), false);
});

test("rejects a correct digest carrying the wrong algorithm prefix", () => {
  // Same length as a valid header, so the length guard cannot be what rejects
  // it. Only the prefix check can, which is what this pins.
  assert.equal(signatureIsValid(BODY, `sha512=${DIGEST}`, SECRET), false);
});

test("rejects a bare digest with no prefix at all", () => {
  assert.equal(signatureIsValid(BODY, DIGEST, SECRET), false);
});

test("rejects a truncated digest without throwing", () => {
  assert.equal(signatureIsValid(BODY, `sha256=${DIGEST.slice(0, 10)}`, SECRET), false);
});

test("rejects everything when the secret is unset", () => {
  assert.equal(signatureIsValid(BODY, `sha256=${DIGEST}`, undefined), false);
});

// The cases above pin the HMAC arithmetic. They do NOT establish that this
// accepts a real Manifestly delivery, because BODY is a string written here
// rather than bytes Manifestly produced: Manifestly signs `to_json_c14n`
// output, and nothing above exercises that canonicalization.
//
// Capture one real delivery (body bytes verbatim, its X-Manifestly-Signature
// header, and the account's signing secret), put them here, and delete this
// comment. Until then the canonicalization is unverified.
test.todo("accepts a captured production delivery");
