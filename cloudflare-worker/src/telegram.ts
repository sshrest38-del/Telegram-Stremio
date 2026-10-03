/**
 * Telegram payload decoding and credentials synchronization module.
 * Replicates base62 + zlib decoding used by Telegram-Stremio.
 */

import { inflateSync } from "node:zlib";
import { signWorkerRequest } from "./auth";
import { CfConfig, DecodedPayload } from "./types";

const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Decodes a base62 string into a Uint8Array.
 * Equivalent to Python:
 *   num = 0
 *   for char in data: num = num * 62 + ALPHABET.index(char)
 *   return num.to_bytes((num.bit_length() + 7) // 8, 'big')
 */
export function base62Decode(str: string): Uint8Array {
  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const index = BASE62_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base62 character: ${char}`);
    }
    num = num * 62n + BigInt(index);
  }

  if (num === 0n) {
    return new Uint8Array([0]);
  }

  // Convert BigInt to big-endian bytes
  const hex = num.toString(16);
  const paddedHex = hex.length % 2 === 0 ? hex : "0" + hex;
  const len = paddedHex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decodes the base62 + zlib compressed file ID into structured metadata.
 */
export function decodeFilePayload(encodedId: string): DecodedPayload {
  try {
    const compressedBytes = base62Decode(encodedId);
    const decompressed = inflateSync(compressedBytes);
    const jsonStr = new TextDecoder().decode(decompressed);
    return JSON.parse(jsonStr) as DecodedPayload;
  } catch (err) {
    throw new Error(`Failed to decode file payload: ${(err as Error).message}`);
  }
}

// In-memory cache for /api/cf/config
let cachedConfig: CfConfig | null = null;
let cachedConfigTime = 0;
const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Clears cached Telegram configuration (called on POST /api/sync).
 */
export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigTime = 0;
}

/**
 * Fetches Telegram credentials and bot pool from the backend application (/api/cf/config).
 */
export async function getTelegramConfig(backendUrl: string, secret: string): Promise<CfConfig> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigTime < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  const cleanBase = backendUrl.replace(/\/+$/, "");
  const authHeaders = await signWorkerRequest(secret, "GET", "/api/cf/config", "");

  const response = await fetch(`${cleanBase}/api/cf/config`, {
    method: "GET",
    headers: {
      ...authHeaders,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch /api/cf/config: HTTP ${response.status} - ${text.slice(0, 100)}`);
  }

  const data = (await response.json()) as CfConfig;
  cachedConfig = data;
  cachedConfigTime = now;
  return data;
}

/**
 * Simple round-robin bot client selector.
 */
let botIndexCounter = 0;
export function selectBotToken(bots: string[]): { token: string; index: number } | null {
  if (!bots || bots.length === 0) {
    return null;
  }
  const index = botIndexCounter % bots.length;
  botIndexCounter = (botIndexCounter + 1) % bots.length;
  return { token: bots[index], index };
}
