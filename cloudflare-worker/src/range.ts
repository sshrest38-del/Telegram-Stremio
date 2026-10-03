/**
 * RFC 9110 / RFC 7233 compliant HTTP byte-range engine.
 * Handles single range slicing, suffix ranges, open-ended ranges, and unsatisfiable ranges.
 */

import { BadRequestError, RangeNotSatisfiableError } from "./errors";
import { ByteRange } from "./types";

/**
 * Parses an incoming HTTP Range header.
 *
 * Supported formats:
 * - bytes=start-end (e.g. bytes=0-1048575)
 * - bytes=start-    (e.g. bytes=1048576-)
 * - bytes=-suffix   (e.g. bytes=-1048576)
 *
 * Rejects multi-range requests cleanly (unsupported by video players and stream proxies).
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  totalSize?: number
): ByteRange {
  if (!rangeHeader || !rangeHeader.trim()) {
    return {
      start: 0,
      end: totalSize !== undefined && totalSize > 0 ? totalSize - 1 : -1,
      total: totalSize,
      isRangeRequest: false,
    };
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith("bytes=")) {
    throw new BadRequestError("Invalid Range unit; only 'bytes' is supported");
  }

  const spec = trimmed.slice("bytes=".length).trim();

  // Multi-range check (comma separated)
  if (spec.includes(",")) {
    throw new BadRequestError("Multipart byte ranges are not supported");
  }

  const parts = spec.split("-");
  if (parts.length !== 2) {
    throw new RangeNotSatisfiableError(totalSize);
  }

  const [startStr, endStr] = parts.map((p) => p.trim());

  let start: number;
  let end: number;

  if (startStr === "" && endStr === "") {
    throw new RangeNotSatisfiableError(totalSize);
  }

  if (startStr === "") {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffixLength = parseInt(endStr, 10);
    if (isNaN(suffixLength) || suffixLength <= 0) {
      throw new RangeNotSatisfiableError(totalSize);
    }
    if (totalSize !== undefined && totalSize > 0) {
      start = Math.max(0, totalSize - suffixLength);
      end = totalSize - 1;
    } else {
      // If total size unknown at parse time, mark as suffix request
      start = -suffixLength;
      end = -1;
    }
  } else if (endStr === "") {
    // Open-ended range: bytes=1000-
    start = parseInt(startStr, 10);
    if (isNaN(start) || start < 0) {
      throw new RangeNotSatisfiableError(totalSize);
    }
    end = totalSize !== undefined && totalSize > 0 ? totalSize - 1 : -1;
  } else {
    // Standard closed range: bytes=100-200
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) {
      throw new RangeNotSatisfiableError(totalSize);
    }
  }

  // Validate bounds if totalSize is known
  if (totalSize !== undefined && totalSize > 0) {
    if (start >= totalSize || (end !== -1 && start > end)) {
      throw new RangeNotSatisfiableError(totalSize);
    }
    if (end >= totalSize) {
      end = totalSize - 1;
    }
  }

  return {
    start,
    end,
    total: totalSize,
    isRangeRequest: true,
  };
}

/**
 * Resolves any pending relative/suffix ranges once the total size is determined.
 */
export function resolveRangeBounds(range: ByteRange, totalSize: number): ByteRange {
  let start = range.start;
  let end = range.end;

  if (start < 0) {
    // Suffix range
    const suffix = -start;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (end < 0 || end >= totalSize) {
    end = totalSize - 1;
  }

  if (start >= totalSize || start > end) {
    throw new RangeNotSatisfiableError(totalSize);
  }

  return {
    start,
    end,
    total: totalSize,
    isRangeRequest: range.isRangeRequest,
  };
}

/**
 * Formats standard Content-Range header value.
 */
export function formatContentRange(start: number, end: number, total: number | string): string {
  return `bytes ${start}-${end}/${total}`;
}

/**
 * Builds standard streaming headers.
 */
export function buildStreamingHeaders(
  mimeType: string,
  fileName: string,
  reqLength: number,
  range: ByteRange,
  totalSize: number,
  cacheControl: string = "public, max-age=3600"
): Headers {
  const headers = new Headers();
  headers.set("Content-Type", mimeType || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", reqLength.toString());
  headers.set("Cache-Control", cacheControl);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Disposition"
  );

  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "").replace(/"/g, "") || "file";
  const utf8Name = encodeURIComponent(fileName);
  headers.set(
    "Content-Disposition",
    `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
  );

  if (range.isRangeRequest) {
    headers.set("Content-Range", formatContentRange(range.start, range.end, totalSize));
  }

  return headers;
}
