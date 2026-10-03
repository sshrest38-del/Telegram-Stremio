/**
 * Type definitions for the Telegram-Stremio Cloudflare Streaming Worker.
 */

export interface Env {
  /** Primary HMAC-SHA256 secret shared with Telegram-Stremio */
  SHARED_SECRET: string;
  /** Optional previous secret for zero-downtime secret rotation */
  PREVIOUS_SHARED_SECRET?: string;
  /** Origin URL of the Telegram-Stremio backend (e.g. https://your-server.koyeb.app) */
  BACKEND_URL: string;
  /** Streaming engine mode: "origin" (default) | "gateway" */
  STREAM_MODE?: "origin" | "gateway";
  /** Optional external MTProto gateway URL */
  GATEWAY_URL?: string;
  /** Whether to enable Cloudflare edge chunk caching ("true" | "false") */
  CF_CACHE_CHUNKS?: string;
  /** Protocol version (defaults to "1") */
  PROTOCOL_VERSION?: string;
  /** Identifier for this worker node/member in usage telemetry */
  WORKER_MEMBER_ID?: string;
}

export interface StreamDescriptor {
  token: string;
  fileId: string;
  fileName: string;
  expires: number;
  signature: string;
}

export interface ByteRange {
  start: number;
  end: number;
  total?: number;
  isRangeRequest: boolean;
}

export interface LiveStreamItem {
  id: string;
  token: string;
  since: number;
  last: number;
  bytes: number;
  msg?: number;
  chat?: number;
  file?: string;
  name?: string;
  ip?: string;
}

export interface StreamStartItem {
  token: string;
  ip: string;
  ua: string;
}

export interface UsageReportPayload {
  usage: Record<string, number>;
  starts: StreamStartItem[];
  streams: LiveStreamItem[];
  member: string;
  client_index?: number;
  dc?: number;
}

export interface CfConfig {
  api_id: number;
  api_hash: string;
  bots: string[];
  user_session?: string;
}

export interface DecodedSinglePart {
  chat_id: number | string;
  msg_id: number;
  global?: boolean;
}

export interface DecodedSplitPart {
  chat_id: number | string;
  msg_id: number;
}

export interface DecodedPayload {
  chat_id?: number | string;
  msg_id?: number;
  parts?: DecodedSplitPart[];
  zip?: boolean;
  global?: boolean;
}
