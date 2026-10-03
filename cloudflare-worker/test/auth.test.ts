import { describe, expect, it } from "vitest";
import {
  computeHmacHex,
  signWorkerRequest,
  timingSafeEqual,
  verifyBackendRequest,
  verifyStreamSignature,
} from "../src/auth";

describe("auth.ts — Cryptographic Security & Signatures", () => {
  const secret = "test_super_secret_key_12345";
  const prevSecret = "old_secret_key_67890";
  const token = "api_tok_user_42";
  const fileId = "7aB9xK";
  const now = Math.floor(Date.now() / 1000);
  const futureExp = now + 3600; // 1 hour ahead
  const pastExp = now - 60; // 1 min ago

  it("timingSafeEqual correctly compares matching and non-matching strings", () => {
    expect(timingSafeEqual("abcdef", "abcdef")).toBe(true);
    expect(timingSafeEqual("abcdef", "abcdeg")).toBe(false);
    expect(timingSafeEqual("abcdef", "abc")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("computes valid HMAC-SHA256 hex string", async () => {
    const hex = await computeHmacHex("secret", "hello world");
    expect(hex).toHaveLength(64);
    // Known test vector for HMAC-SHA256("secret", "hello world")
    expect(hex).toBe("734cc62f32841568f45715aeb9f4d7891324e6d948e4c6c60c0621cdac48623a");
  });

  it("verifies valid stream signature created with current secret", async () => {
    const message = `/dl/${token}/${fileId}:${futureExp}`;
    const sig = (await computeHmacHex(secret, message)).slice(0, 32);

    const result = await verifyStreamSignature(secret, undefined, token, fileId, futureExp, sig);
    expect(result.valid).toBe(true);
  });

  it("rejects expired stream URL even if signature is valid", async () => {
    const message = `/dl/${token}/${fileId}:${pastExp}`;
    const sig = (await computeHmacHex(secret, message)).slice(0, 32);

    const result = await verifyStreamSignature(secret, undefined, token, fileId, pastExp, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("rejects tampered token in stream URL", async () => {
    const message = `/dl/${token}/${fileId}:${futureExp}`;
    const sig = (await computeHmacHex(secret, message)).slice(0, 32);

    const result = await verifyStreamSignature(
      secret,
      undefined,
      "tampered_token",
      fileId,
      futureExp,
      sig
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Signature mismatch");
  });

  it("rejects tampered file ID in stream URL", async () => {
    const message = `/dl/${token}/${fileId}:${futureExp}`;
    const sig = (await computeHmacHex(secret, message)).slice(0, 32);

    const result = await verifyStreamSignature(
      secret,
      undefined,
      token,
      "tampered_file_id",
      futureExp,
      sig
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Signature mismatch");
  });

  it("rejects signature checked against wrong secret", async () => {
    const message = `/dl/${token}/${fileId}:${futureExp}`;
    const sig = (await computeHmacHex(secret, message)).slice(0, 32);

    const result = await verifyStreamSignature(
      "wrong_secret",
      undefined,
      token,
      fileId,
      futureExp,
      sig
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Signature mismatch");
  });

  it("supports secret rotation: accepts signature signed with previous secret", async () => {
    const message = `/dl/${token}/${fileId}:${futureExp}`;
    const sigFromOld = (await computeHmacHex(prevSecret, message)).slice(0, 32);

    const result = await verifyStreamSignature(
      secret,
      prevSecret,
      token,
      fileId,
      futureExp,
      sigFromOld
    );
    expect(result.valid).toBe(true);
  });

  it("signs and verifies worker requests with clock skew protection", async () => {
    const signedHeaders = await signWorkerRequest(secret, "POST", "/api/cf/usage", '{"usage":100}');
    const ts = signedHeaders["x-cf-time"];
    const sig = signedHeaders["x-cf-sig"];

    const valid = await verifyBackendRequest(
      secret,
      undefined,
      "POST",
      "/api/cf/usage",
      '{"usage":100}',
      ts,
      sig
    );
    expect(valid).toBe(true);

    // Replay with outdated timestamp (> 300s) fails
    const oldTs = (parseInt(ts, 10) - 301).toString();
    const staleValid = await verifyBackendRequest(
      secret,
      undefined,
      "POST",
      "/api/cf/usage",
      '{"usage":100}',
      oldTs,
      sig
    );
    expect(staleValid).toBe(false);
  });
});
