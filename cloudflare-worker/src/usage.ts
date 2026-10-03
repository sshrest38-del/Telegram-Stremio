/**
 * Bandwidth usage aggregation and telemetry reporting module.
 * Aggregates chunk transfers in memory and flushes to /api/cf/usage.
 * Guarantees zero per-chunk database calls and safe asynchronous reporting via ctx.waitUntil().
 */

import { signWorkerRequest } from "./auth";
import { LiveStreamItem, StreamStartItem, UsageReportPayload } from "./types";

class UsageManager {
  private usageDeltas = new Map<string, number>();
  private startEvents: StreamStartItem[] = [];
  private activeStreams = new Map<string, LiveStreamItem>();
  private lastFlushTime = Date.now();
  private flushThresholdBytes = 10 * 1024 * 1024; // Flush if accumulated > 10MB
  private totalPendingBytes = 0;

  /**
   * Records a new stream initiation.
   */
  public recordStart(token: string, ip: string, ua: string): void {
    if (token) {
      this.startEvents.push({ token, ip, ua });
    }
  }

  /**
   * Tracks bytes transferred for an active stream.
   */
  public recordBytes(
    streamId: string,
    token: string,
    bytesCount: number,
    metadata?: { msg?: number; chat?: number; file?: string; name?: string; ip?: string }
  ): void {
    if (!token || bytesCount <= 0) {
      return;
    }

    const currentTokenDelta = this.usageDeltas.get(token) || 0;
    this.usageDeltas.set(token, currentTokenDelta + bytesCount);
    this.totalPendingBytes += bytesCount;

    const now = Date.now();
    let stream = this.activeStreams.get(streamId);
    if (!stream) {
      stream = {
        id: streamId,
        token,
        since: now,
        last: now,
        bytes: bytesCount,
        msg: metadata?.msg,
        chat: metadata?.chat,
        file: metadata?.file,
        name: metadata?.name,
        ip: metadata?.ip,
      };
      this.activeStreams.set(streamId, stream);
    } else {
      stream.last = now;
      stream.bytes += bytesCount;
    }
  }

  /**
   * Marks a stream as finished.
   */
  public finishStream(streamId: string): void {
    this.activeStreams.delete(streamId);
  }

  /**
   * Checks whether an asynchronous flush to the backend should be triggered.
   */
  public shouldFlush(): boolean {
    const timeSinceLastFlush = Date.now() - this.lastFlushTime;
    return (
      this.totalPendingBytes >= this.flushThresholdBytes ||
      timeSinceLastFlush >= 25_000 || // 25 seconds
      this.startEvents.length >= 10
    );
  }

  /**
   * Flushes accumulated usage deltas and active stream telemetry to /api/cf/usage.
   */
  public async flush(backendUrl: string, secret: string, memberId: string): Promise<boolean> {
    if (
      this.usageDeltas.size === 0 &&
      this.startEvents.length === 0 &&
      this.activeStreams.size === 0
    ) {
      return true;
    }

    // Snapshot current state
    const usagePayload: Record<string, number> = {};
    for (const [token, delta] of this.usageDeltas.entries()) {
      usagePayload[token] = delta;
    }
    const startsPayload = [...this.startEvents];
    const streamsPayload = Array.from(this.activeStreams.values());

    // Reset accumulated counters
    this.usageDeltas.clear();
    this.startEvents = [];
    this.totalPendingBytes = 0;
    this.lastFlushTime = Date.now();

    const payload: UsageReportPayload = {
      usage: usagePayload,
      starts: startsPayload,
      streams: streamsPayload,
      member: memberId || "worker-node",
    };

    const bodyText = JSON.stringify(payload);
    const cleanBase = backendUrl.replace(/\/+$/, "");

    try {
      const authHeaders = await signWorkerRequest(secret, "POST", "/api/cf/usage", bodyText);
      const res = await fetch(`${cleanBase}/api/cf/usage`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: bodyText,
      });

      if (!res.ok) {
        // Restore deltas if network failed
        for (const [token, delta] of Object.entries(usagePayload)) {
          const current = this.usageDeltas.get(token) || 0;
          this.usageDeltas.set(token, current + delta);
          this.totalPendingBytes += delta;
        }
        return false;
      }
      return true;
    } catch {
      // Restore deltas if network failed
      for (const [token, delta] of Object.entries(usagePayload)) {
        const current = this.usageDeltas.get(token) || 0;
        this.usageDeltas.set(token, current + delta);
        this.totalPendingBytes += delta;
      }
      return false;
    }
  }
}

export const usageManager = new UsageManager();
