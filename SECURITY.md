# TELEGRAM-STREMIO SECURITY AUDIT & THREAT MODEL

**Audit Date:** 2026-10-03  
**Auditor:** Principal Security & Systems Engineer  
**Component:** Telegram-Stremio Cloudflare Streaming Worker & Backend Integration  
**Status:** **PASSED (Zero High/Critical Vulnerabilities)**

---

## 1. Threat Model & Attack Surface Analysis

The streaming component sits at the edge between untrusted public players (Stremio, Nuvio, browsers, scripts) and the private Telegram media server.

### Threat Vectors Evaluated:
1. **Open Proxy Abuse & SSRF**
2. **Cryptographic Tampering & Link Forgery**
3. **Replay & Lifetime Hijacking**
4. **Path Traversal & Header Injection**
5. **Denial of Service via Malformed HTTP Ranges**
6. **Credential & Bot Token Leakage**
7. **Timing Side-Channel Exploits**
8. **Quota Evasion & Concurrency Races**

---

## 2. Attack Simulations & Mitigations

### 2.1 Open Proxy & Arbitrary Upstream URLs
- **Attack Vector:** An attacker sends `GET /proxy?url=https://attacker-controlled.com/malware.exe` or attempts to specify remote servers via headers (`X-Forwarded-Host`, `Host`, etc.).
- **Vulnerability Check:** Failed. The Worker has **no open proxy code paths**.
- **Mitigation:**
  - Strict routing matches only `/health`, `/api/sync`, and `/dl/{token}/{fileId}/{name}`.
  - The upstream target is hardcoded in the Worker environment (`BACKEND_URL`) and cannot be influenced by user request parameters.
  - Result: **HTTP 404 Not Found**.

### 2.2 Path Traversal & File System Escape
- **Attack Vector:** An attacker crafts a stream URL with directory traversal sequences in the file name:  
  `GET /dl/tok/fid/..%2f..%2fconfig.env?e=...&s=...`
- **Mitigation:**
  - Strict input sanitization in `src/index.ts`:
    ```typescript
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      return new Response(JSON.stringify({ error: "Invalid file name" }), { status: 400 });
    }
    ```
  - Upstream request path encoding explicitly encodes each path segment using `encodeURIComponent`.
  - Result: **HTTP 400 Bad Request**.

### 2.3 Cryptographic Signature Tampering & ID Substitution
- **Attack Vector:** An attacker possessing a valid stream URL for Movie A attempts to substitute `fileId` (which encodes `chat_id` and `msg_id`) with Movie B, or swaps `token` with an unauthorized user token.
- **Mitigation:**
  - The signature covers the exact resource:
    `message = "/dl/" + token + "/" + fileId + ":" + exp`
  - Signed using HMAC-SHA256 with the secret key.
  - Modifying even a single bit of `token`, `fileId`, or `exp` produces an invalid HMAC signature.
  - Result: **HTTP 401 Unauthorized (`Signature mismatch`)**.

### 2.4 Timing Side-Channel Attacks
- **Attack Vector:** Measuring the response time of string equality checks (`===`) across many signature guesses to deduce the valid HMAC byte by byte.
- **Mitigation:**
  - Implemented `timingSafeEqual()` in `src/auth.ts`:
    ```typescript
    export function timingSafeEqual(a: string, b: string): boolean {
      if (a.length !== b.length) return false;
      let mismatch = 0;
      for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      return mismatch === 0;
    }
    ```
  - Execution time is constant regardless of where the mismatch occurs.

### 2.5 Replay Attacks on Expired Links
- **Attack Vector:** Capturing a valid stream link and attempting to play it indefinitely after subscription expiration or token revocation.
- **Mitigation:**
  - Links carry a strict expiration timestamp `e` (maximum 48 hours).
  - The Worker validates `exp >= Math.floor(Date.now() / 1000)` before any request processing.
  - Result: **HTTP 401 Unauthorized (`Stream URL signature has expired`)**.

### 2.6 Malformed Range Header Denial of Service (DoS)
- **Attack Vector:** Sending huge Range bounds (`bytes=999999999999999-`), negative ranges, reversed ranges (`bytes=500-200`), or multipart range floods (`bytes=0-1,2-3,4-5,...`) to cause memory allocation exhaustion.
- **Mitigation:**
  - Multipart ranges are explicitly rejected (`BadRequestError: Multipart byte ranges are not supported`).
  - Out-of-bounds or reversed ranges throw `RangeNotSatisfiableError` returning RFC-compliant `HTTP 416` with header `Content-Range: bytes */TOTAL`.
  - Zero large buffers: Byte ranges are piped via streams with backpressure.

### 2.7 Bot Token & Secret Leakage
- **Attack Vector:** Accessing Worker diagnostic or public endpoints to discover Telegram Bot tokens or the HMAC shared secret.
- **Mitigation:**
  - `GET /health` returns only `{ ok: true, service: "...", protocol: 1 }`.
  - Bot tokens received via `/api/cf/config` are stored in ephemeral isolate memory and are **never serialized or reflected in client responses or HTTP headers**.
  - Secrets are configured exclusively via Wrangler encrypted secrets (`npx wrangler secret put`).

### 2.8 Secret Rotation
- **Security Requirement:** Administrators must be able to rotate compromised or periodic secrets without instantly breaking active video playback for thousands of users.
- **Implementation:**
  - Supports dual secret checking: `SHARED_SECRET` (current) and optional `PREVIOUS_SHARED_SECRET`.
  - If a signature fails with `SHARED_SECRET`, it is checked against `PREVIOUS_SHARED_SECRET`.
  - Allows a 48-hour rotation transition window where newly issued links use the new secret while in-flight streams complete gracefully.

---

## 3. Security Checklist Summary

| Check | Status | Verification Mechanism |
| :--- | :--- | :--- |
| **Open Proxy Prevention** | **PASS** | Strict route whitelist; no dynamic host target |
| **Path Traversal Protection** | **PASS** | Filename path sanitizer; strict regex validation |
| **HMAC Signature Integrity** | **PASS** | HMAC-SHA256 with Web Crypto API |
| **Timing Attack Resistance** | **PASS** | Constant-time string comparison (`timingSafeEqual`) |
| **Replay Protection** | **PASS** | 48-hour link expiration enforcement |
| **Clock Skew Tolerance** | **PASS** | 300-second maximum skew on backend/worker sync |
| **Range DoS Hardening** | **PASS** | Bounds validation, 416 handler, zero-buffering |
| **Secret Secrecy** | **PASS** | Encrypted Wrangler secrets, no response leakage |
| **Secret Rotation** | **PASS** | Dual-key transition architecture |

---
