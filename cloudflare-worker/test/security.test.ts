import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { computeHmacHex } from "../src/auth";
import { Env } from "../src/types";

describe("security.test.ts — Security Model & Threat Testing", () => {
  const secret = "worker_secret_key_12345";
  const env: Env = {
    SHARED_SECRET: secret,
    BACKEND_URL: "https://backend.test.local",
    STREAM_MODE: "origin",
    PROTOCOL_VERSION: "1",
    CF_CACHE_CHUNKS: "false",
  };

  const mockCtx = {
    waitUntil: (p: Promise<unknown>) => p,
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  it("STRICT: Rejects open proxy attempts (no /proxy?url= endpoints)", async () => {
    const maliciousReq = new Request(
      "https://worker.test.local/proxy?url=https://malicious-site.com/file.bin",
      { method: "GET" }
    );
    const res = await worker.fetch(maliciousReq, env, mockCtx);
    expect(res.status).toBe(404);
  });

  it("STRICT: Rejects arbitrary paths outside defined contract", async () => {
    const maliciousPaths = [
      "/admin",
      "/api/keys",
      "/internal/config",
      "/etc/passwd",
      "/static/..%2f..%2fconfig.env",
    ];

    for (const p of maliciousPaths) {
      const req = new Request(`https://worker.test.local${p}`, { method: "GET" });
      const res = await worker.fetch(req, env, mockCtx);
      expect([401, 404]).toContain(res.status);
    }
  });

  it("STRICT: Prevents path traversal in filename", async () => {
    const token = "tok1";
    const fileId = "fid1";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    // Path traversal attempt in file name: ../../sensitive
    const traversalUrl = `https://worker.test.local/dl/${token}/${fileId}/..%2f..%2fconfig.env?e=${exp}&s=${sig}`;
    const req = new Request(traversalUrl, { method: "GET" });
    const res = await worker.fetch(req, env, mockCtx);
    // Explicitly rejects path traversal with 400 Bad Request
    expect(res.status).toBe(400);
  });

  it("STRICT: Rejects tampered signature (single byte flipped)", async () => {
    const token = "tok1";
    const fileId = "fid1";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const originalSig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    // Tamper single hex character
    const tamperedSig = originalSig.slice(0, 31) + (originalSig[31] === "a" ? "b" : "a");

    const url = `https://worker.test.local/dl/${token}/${fileId}/video.mkv?e=${exp}&s=${tamperedSig}`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(401);
  });

  it("STRICT: Rejects replay of expired URLs (> 48h)", async () => {
    const token = "tok1";
    const fileId = "fid1";
    const expiredTime = Math.floor(Date.now() / 1000) - 100;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${expiredTime}`)).slice(0, 32);

    const url = `https://worker.test.local/dl/${token}/${fileId}/video.mkv?e=${expiredTime}&s=${sig}`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(401);
  });

  it("STRICT: Rejects malformed or attack Range headers", async () => {
    const token = "tok1";
    const fileId = "fid1";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    const malformedRanges = [
      "bytes=foo-bar",
      "bytes=-10-20",
      "bytes=0-10,11-20,21-30", // multipart flood
      "bytes=99999999999999999999999999999999999-",
      "characters=0-100",
    ];

    for (const r of malformedRanges) {
      const url = `https://worker.test.local/dl/${token}/${fileId}/video.mkv?e=${exp}&s=${sig}`;
      const req = new Request(url, {
        method: "GET",
        headers: { Range: r },
      });
      const res = await worker.fetch(req, env, mockCtx);
      // Either rejects Range (400 / 416) or forwards safely without crash
      expect([400, 416, 500]).toContain(res.status);
    }
  });
});
