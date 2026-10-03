/**
 * Telegram-Stremio Self-Hosted Cloudflare Streaming Worker
 * Clean-room, high-throughput, byte-transparent streaming proxy.
 */

import { verifyBackendRequest, verifyStreamSignature } from "./auth";
import { HttpError, RangeNotSatisfiableError } from "./errors";
import { parseRangeHeader } from "./range";
import { decodeFilePayload, invalidateConfigCache } from "./telegram";
import { Env } from "./types";
import { usageManager } from "./usage";

const PROTOCOL_VERSION = 1;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type, x-cf-time, x-cf-sig",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      // 1. Health check & Diagnostics
      if (path === "/health" || path === "/") {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "telegram-stremio-worker",
            protocol: PROTOCOL_VERSION,
            version: "1.0.0",
            timestamp: Math.floor(Date.now() / 1000),
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
            },
          }
        );
      }

      // 2. Synchronize credentials / tokens notification from Backend
      if (path === "/api/sync" && request.method === "POST") {
        const bodyText = await request.text();
        const ts = request.headers.get("x-cf-time") || "";
        const sig = request.headers.get("x-cf-sig") || "";

        const isValid = await verifyBackendRequest(
          env.SHARED_SECRET,
          env.PREVIOUS_SHARED_SECRET,
          "POST",
          "/api/sync",
          bodyText,
          ts,
          sig
        );

        if (!isValid) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        invalidateConfigCache();
        return new Response(JSON.stringify({ ok: true, synced: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 3. Media streaming endpoint: /dl/{token}/{file_id}/{name}
      const dlMatch = path.match(/^\/dl\/([^/]+)\/([^/]+)\/(.+)$/);
      if (dlMatch && (request.method === "GET" || request.method === "HEAD")) {
        const [, token, fileId, encodedFileName] = dlMatch;
        const fileName = decodeURIComponent(encodedFileName);

        // Path traversal protection
        if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
          return new Response(JSON.stringify({ error: "Invalid file name" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Authenticate signed link
        const expStr = url.searchParams.get("e") || "";
        const sig = url.searchParams.get("s") || "";
        const exp = parseInt(expStr, 10);

        const authResult = await verifyStreamSignature(
          env.SHARED_SECRET,
          env.PREVIOUS_SHARED_SECRET,
          token,
          fileId,
          exp,
          sig
        );

        if (!authResult.valid) {
          return new Response(
            JSON.stringify({ error: "Unauthorized", detail: authResult.reason }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Decode payload to extract telegram IDs for telemetry
        let metadata: { msg?: number; chat?: number; file?: string; name?: string; ip?: string } = {};
        try {
          const decoded = decodeFilePayload(fileId);
          metadata = {
            msg: decoded.msg_id || (decoded.parts && decoded.parts[0]?.msg_id),
            chat: typeof decoded.chat_id === "number" ? decoded.chat_id : undefined,
            file: fileId,
            name: fileName,
            ip: request.headers.get("cf-connecting-ip") || "unknown",
          };
        } catch {
          metadata = { file: fileId, name: fileName, ip: request.headers.get("cf-connecting-ip") || "unknown" };
        }

        // Record stream start in telemetry
        const clientIp = request.headers.get("cf-connecting-ip") || "";
        const userAgent = request.headers.get("user-agent") || "";
        usageManager.recordStart(token, clientIp, userAgent);

        // Parse client Range header
        const rawRange = request.headers.get("Range");
        const clientRange = parseRangeHeader(rawRange);

        // Build upstream URL
        const backendBase = (env.BACKEND_URL || "").replace(/\/+$/, "");
        if (!backendBase) {
          return new Response(JSON.stringify({ error: "BACKEND_URL is not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const upstreamUrl = `${backendBase}/dl/${encodeURIComponent(token)}/${encodeURIComponent(
          fileId
        )}/${encodeURIComponent(fileName)}`;

        // Prepare upstream request headers
        const upstreamHeaders = new Headers();
        if (rawRange) {
          upstreamHeaders.set("Range", rawRange);
        }
        upstreamHeaders.set("User-Agent", userAgent || "Telegram-Stremio-Worker");
        upstreamHeaders.set("Accept", "*/*");
        // Strictly prevent gzip/brotli compression on media streams to avoid latency/buffering
        upstreamHeaders.set("Accept-Encoding", "identity");

        // Forward request with cancellation propagation via request.signal
        const fetchInit: RequestInit & { cf?: any } = {
          method: request.method,
          headers: upstreamHeaders,
          signal: request.signal,
        };

        if (env.CF_CACHE_CHUNKS === "true") {
          fetchInit.cf = {
            cacheEverything: true,
            cacheTtl: 86400,
          };
        }

        const upstreamRes = await fetch(upstreamUrl, fetchInit);

        // Handle upstream errors cleanly
        if (!upstreamRes.ok && upstreamRes.status !== 206) {
          if (upstreamRes.status === 416) {
            const contentRange = upstreamRes.headers.get("Content-Range") || "bytes */*";
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: {
                "Content-Range": contentRange,
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers: {
              "Content-Type": upstreamRes.headers.get("Content-Type") || "text/plain",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Prepare response headers
        const responseHeaders = new Headers();
        for (const [key, val] of upstreamRes.headers.entries()) {
          const lower = key.toLowerCase();
          if (
            lower === "content-type" ||
            lower === "content-length" ||
            lower === "content-range" ||
            lower === "accept-ranges" ||
            lower === "content-disposition" ||
            lower === "etag" ||
            lower === "last-modified"
          ) {
            responseHeaders.set(key, val);
          }
        }

        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set(
          "Access-Control-Expose-Headers",
          "Content-Length, Content-Range, Accept-Ranges, Content-Disposition"
        );
        // Explicitly disable proxy buffering and transcoding for real-time video delivery
        responseHeaders.set("X-Accel-Buffering", "no");
        responseHeaders.set(
          "Cache-Control",
          env.CF_CACHE_CHUNKS === "true" ? "public, max-age=86400, no-transform" : "public, max-age=3600, no-transform"
        );

        if (request.method === "HEAD") {
          return new Response(null, {
            status: upstreamRes.status,
            headers: responseHeaders,
          });
        }

        // Track usage from headers (O(1), zero CPU overhead, pure native wire-speed passthrough)
        const streamId = crypto.randomUUID();
        const memberId = env.WORKER_MEMBER_ID || request.headers.get("cf-ray") || "worker-node";
        const contentLengthHeader = upstreamRes.headers.get("Content-Length");
        const transferredBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

        if (transferredBytes > 0) {
          usageManager.recordBytes(streamId, token, transferredBytes, metadata);
          if (usageManager.shouldFlush()) {
            ctx.waitUntil(usageManager.flush(backendBase, env.SHARED_SECRET, memberId));
          }
        }

        // Pass native body stream directly to client without JS event-loop chunk throttling
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: responseHeaders,
        });
      }

      // Route not found
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(err.message, {
          status: err.status,
          headers: {
            ...err.headers,
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain",
          },
        });
      }

      const message = err instanceof Error ? err.message : "Internal Server Error";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
