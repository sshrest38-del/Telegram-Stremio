import { describe, expect, it } from "vitest";
import { BadRequestError, RangeNotSatisfiableError } from "../src/errors";
import {
  buildStreamingHeaders,
  formatContentRange,
  parseRangeHeader,
  resolveRangeBounds,
} from "../src/range";

describe("range.ts — RFC 9110 HTTP Byte Range Engine", () => {
  const totalFileSize = 2 * 1024 * 1024 * 1024; // 2 GiB

  it("parses empty or missing range as full file request", () => {
    const range = parseRangeHeader(null, totalFileSize);
    expect(range.isRangeRequest).toBe(false);
    expect(range.start).toBe(0);
    expect(range.end).toBe(totalFileSize - 1);
  });

  it("parses standard closed range: bytes=0-1023", () => {
    const range = parseRangeHeader("bytes=0-1023", totalFileSize);
    expect(range.isRangeRequest).toBe(true);
    expect(range.start).toBe(0);
    expect(range.end).toBe(1023);
  });

  it("parses 1 MiB middle range", () => {
    const range = parseRangeHeader("bytes=1048576-2097151", totalFileSize);
    expect(range.isRangeRequest).toBe(true);
    expect(range.start).toBe(1048576);
    expect(range.end).toBe(2097151);
  });

  it("parses open-ended range: bytes=1048576-", () => {
    const range = parseRangeHeader("bytes=1048576-", totalFileSize);
    expect(range.isRangeRequest).toBe(true);
    expect(range.start).toBe(1048576);
    expect(range.end).toBe(totalFileSize - 1);
  });

  it("parses suffix range: bytes=-1048576 (last 1 MiB)", () => {
    const range = parseRangeHeader("bytes=-1048576", totalFileSize);
    expect(range.isRangeRequest).toBe(true);
    expect(range.start).toBe(totalFileSize - 1048576);
    expect(range.end).toBe(totalFileSize - 1);
  });

  it("resolves suffix range when total size is supplied later", () => {
    const pendingRange = parseRangeHeader("bytes=-1000");
    expect(pendingRange.start).toBe(-1000);
    const resolved = resolveRangeBounds(pendingRange, 5000);
    expect(resolved.start).toBe(4000);
    expect(resolved.end).toBe(4999);
  });

  it("throws RangeNotSatisfiableError (416) when range exceeds total size", () => {
    expect(() => {
      parseRangeHeader("bytes=999999999999999-", totalFileSize);
    }).toThrow(RangeNotSatisfiableError);
  });

  it("throws RangeNotSatisfiableError (416) when start > end", () => {
    expect(() => {
      parseRangeHeader("bytes=500-200", totalFileSize);
    }).toThrow(RangeNotSatisfiableError);
  });

  it("throws BadRequestError (400) for multipart ranges", () => {
    expect(() => {
      parseRangeHeader("bytes=0-100,200-300", totalFileSize);
    }).toThrow(BadRequestError);
  });

  it("throws BadRequestError (400) for non-byte units", () => {
    expect(() => {
      parseRangeHeader("items=0-10", totalFileSize);
    }).toThrow(BadRequestError);
  });

  it("formats standard Content-Range header correctly", () => {
    expect(formatContentRange(0, 1023, totalFileSize)).toBe(
      `bytes 0-1023/${totalFileSize}`
    );
  });

  it("builds correct streaming headers with UTF-8 filename disposition", () => {
    const range = { start: 0, end: 1048575, isRangeRequest: true };
    const headers = buildStreamingHeaders(
      "video/mp4",
      "Inception (2010).mp4",
      1048576,
      range,
      totalFileSize
    );

    expect(headers.get("Content-Type")).toBe("video/mp4");
    expect(headers.get("Content-Length")).toBe("1048576");
    expect(headers.get("Accept-Ranges")).toBe("bytes");
    expect(headers.get("Content-Range")).toBe(`bytes 0-1048575/${totalFileSize}`);
    expect(headers.get("Content-Disposition")).toContain("Inception (2010).mp4");
  });
});
