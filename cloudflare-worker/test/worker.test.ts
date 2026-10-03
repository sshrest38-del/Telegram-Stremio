import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "../src/index";
import { computeHmacHex, signWorkerRequest } from "../src/auth";
import { Env } from "../src/types";

describe("worker.test.ts — End-to-End Worker Request Pipeline", () => {
  const secret = "worker_secret_key_12345";
  const env: Env = {
    SHARED_SECRET: secret,
    BACKEND_URL: "https://backend.test.local",
    STREAM_MODE: "origin",
    PROTOCOL_VERSION: "1",
    CF_CACHE_CHUNKS: "false",
  };

  const mockCtx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles GET /health cleanly", async () => {
    const req = new Request("https://worker.test.local/health", { method: "GET" });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; protocol: number };
    expect(json.ok).toBe(true);
    expect(json.protocol).toBe(1);
  });

  it("handles CORS preflight OPTIONS request", async () => {
    const req = new Request("https://worker.test.local/dl/tok/fid/name.mkv", {
      method: "OPTIONS",
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects unauthorized POST /api/sync", async () => {
    const req = new Request("https://worker.test.local/api/sync", {
      method: "POST",
      body: "{}",
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(401);
  });

  it("accepts authenticated POST /api/sync", async () => {
    const signed = await signWorkerRequest(secret, "POST", "/api/sync", "{}");
    const req = new Request("https://worker.test.local/api/sync", {
      method: "POST",
      headers: {
        "x-cf-time": signed["x-cf-time"],
        "x-cf-sig": signed["x-cf-sig"],
      },
      body: "{}",
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; synced: boolean };
    expect(json.synced).toBe(true);
  });

  it("rejects unsigned streaming request at /dl/:token/:fileId/:name", async () => {
    const req = new Request("https://worker.test.local/dl/user_tok/fid123/video.mkv", {
      method: "GET",
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(401);
  });

  it("streams full media content (200 OK) with zero-copy piping", async () => {
    const token = "tok42";
    const fileId = "test_file_id";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    const videoBytes = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]); // ftyp header
    const mockUpstreamResponse = new Response(videoBytes, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": videoBytes.length.toString(),
        "Accept-Ranges": "bytes",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = typeof info === "string" ? info : (info as Request).url;
      if (url.includes("/dl/")) {
        return mockUpstreamResponse;
      }
      return new Response("Not found", { status: 404 });
    });

    const streamUrl = `https://worker.test.local/dl/${token}/${fileId}/video.mp4?e=${exp}&s=${sig}`;
    const req = new Request(streamUrl, { method: "GET" });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");

    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    expect(bodyBytes).toEqual(videoBytes);
  });

  it("forwards Range requests and returns HTTP 206 Partial Content", async () => {
    const token = "tok42";
    const fileId = "test_file_id";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    const chunkBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const mockUpstreamResponse = new Response(chunkBytes, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "5",
        "Content-Range": "bytes 100-104/1000",
        "Accept-Ranges": "bytes",
      },
    });

    let requestedUpstreamRange = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const reqHeaders = (init?.headers as Headers) || new Headers();
      requestedUpstreamRange = reqHeaders.get("Range") || "";
      return mockUpstreamResponse;
    });

    const streamUrl = `https://worker.test.local/dl/${token}/${fileId}/video.mp4?e=${exp}&s=${sig}`;
    const req = new Request(streamUrl, {
      method: "GET",
      headers: { Range: "bytes=100-104" },
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-104/1000");
    expect(requestedUpstreamRange).toBe("bytes=100-104");
  });

  it("handles 416 Range Not Satisfiable from upstream", async () => {
    const token = "tok42";
    const fileId = "test_file_id";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": "bytes */1000" },
      });
    });

    const streamUrl = `https://worker.test.local/dl/${token}/${fileId}/video.mp4?e=${exp}&s=${sig}`;
    const req = new Request(streamUrl, {
      method: "GET",
      headers: { Range: "bytes=9999999-" },
    });
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("propagates client abort signal to upstream fetch", async () => {
    const token = "tok42";
    const fileId = "test_file_id";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = (await computeHmacHex(secret, `/dl/${token}/${fileId}:${exp}`)).slice(0, 32);

    let upstreamSignal: AbortSignal | null | undefined = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      upstreamSignal = init?.signal;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const controller = new AbortController();
    const streamUrl = `https://worker.test.local/dl/${token}/${fileId}/video.mp4?e=${exp}&s=${sig}`;
    const req = new Request(streamUrl, {
      method: "GET",
      signal: controller.signal,
    });

    await worker.fetch(req, env, mockCtx);
    expect(upstreamSignal).toBeDefined();

    // Aborting the client controller aborts the upstream signal
    controller.abort();
    expect((upstreamSignal as AbortSignal | null)?.aborted).toBe(true);
  });
});
