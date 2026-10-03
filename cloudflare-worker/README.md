# Telegram-Stremio Self-Hosted Cloudflare Streaming Worker

Production-grade, clean-room Cloudflare Streaming Worker for [Telegram-Stremio](https://github.com/weebzone/Telegram-Stremio).

This Worker handles high-throughput video delivery for Stremio and Nuvio, offloading viewer bandwidth from your VPS/Render/Koyeb host to Cloudflare's global edge network.

---

## Features

- **Byte-Transparent Streaming:** Zero transcoding, zero remuxing, zero codec restrictions. Transparent pass-through for AVC/H.264, HEVC/H.265, AV1, VP9, 10-bit HDR, Dolby Vision, DTS, TrueHD, EAC3, and FLAC in MKV, MP4, and WebM containers.
- **Zero Full-File Buffering:** Never buffers files in memory. Uses high-throughput `ReadableStream` piping with active backpressure.
- **Full RFC 9110 HTTP Range Engine:** Supports standard ranges (`bytes=0-1023`), open-ended ranges (`bytes=1048576-`), and suffix ranges (`bytes=-1048576`). Correctly returns `206 Partial Content` with `Content-Range` and `416 Range Not Satisfiable` for out-of-bounds requests.
- **Fast Random Seeking:** Instant seek anywhere in multi-gigabyte files. Immediate cancellation propagation via `request.signal` aborts obsolete chunk downloads when the viewer seeks or pauses.
- **Full Split-File & Split-ZIP Support:** Transparently handles multi-part split files (`.001`, `.002`) and stored (uncompressed) split ZIP archives.
- **Cryptographic Security (Web Crypto API):** HMAC-SHA256 signature verification with constant-time equality checks (`timingSafeEqual`) to prevent timing side-channels. Supports zero-downtime secret rotation (`SHARED_SECRET` + `PREVIOUS_SHARED_SECRET`).
- **Strict Access Control:** **No open proxy.** Arbitrary upstream URLs are strictly blocked.
- **Automated Usage & Quota Reporting:** Aggregates delivered bytes per token in-memory and asynchronously flushes reports to `/api/cf/usage` via `ctx.waitUntil()`. Preserves daily/monthly data limits and live streaming telemetry on the admin dashboard.
- **Dynamic Config Invalidation:** Responds to signed `POST /api/sync` notifications from Telegram-Stremio when bot tokens or channel settings are updated.

---

## Quick Start & Deployment

### 1. Prerequisites
- Node.js `>= 18.0.0`
- Cloudflare account with Workers enabled

### 2. Installation
```bash
cd cloudflare-worker
npm install
```

### 3. Local Development & Testing
Copy the example environment file and run the test suite:
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your local BACKEND_URL and SHARED_SECRET
npm test
```

### 4. Configure Wrangler
Edit `wrangler.jsonc` to set your Telegram-Stremio backend URL:
```jsonc
{
  "name": "telegram-stremio-streaming-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-02-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "BACKEND_URL": "https://your-telegram-stremio.koyeb.app",
    "STREAM_MODE": "origin",
    "CF_CACHE_CHUNKS": "false",
    "PROTOCOL_VERSION": "1"
  }
}
```

### 5. Set Secret in Cloudflare
Set the shared secret using Wrangler (or in the Cloudflare Dashboard under Worker Settings > Variables):
```bash
npx wrangler secret put SHARED_SECRET
# Enter the secret you plan to configure in Telegram-Stremio Settings
```

If you are rotating secrets, you can also set:
```bash
npx wrangler secret put PREVIOUS_SHARED_SECRET
```

### 6. Deploy
```bash
npm run deploy
```
Wrangler will output your Worker URL, for example:
`https://telegram-stremio-streaming-worker.<your-subdomain>.workers.dev`

---

## Telegram-Stremio Configuration

1. Log in to your Telegram-Stremio Web UI (`/login`).
2. Go to **Settings** -> **Cloudflare Streaming**.
3. Fill in:
   - **Worker URL:** `https://telegram-stremio-streaming-worker.<your-subdomain>.workers.dev`
   - **Shared Secret:** The exact value you set in `npx wrangler secret put SHARED_SECRET`.
   - **Stremio Links:** Select **Both** (to verify both direct and Cloudflare links side-by-side) or **Cloudflare only**.
4. Click **Test Connection** to verify health and authentication.
5. Click **Save Settings**.

---

## Health Check & Verification

Test reachability:
```bash
curl -v https://your-worker.workers.dev/health
```
Expected response:
```json
{
  "ok": true,
  "service": "telegram-stremio-worker",
  "protocol": 1,
  "version": "1.0.0",
  "timestamp": 1775218000
}
```

Test Range streaming:
```bash
curl -v \
  -H "Range: bytes=0-1048575" \
  "https://your-worker.workers.dev/dl/<token>/<file_id>/video.mkv?e=<exp>&s=<sig>"
```
Expected response:
- Status: `HTTP/1.1 206 Partial Content`
- Header: `Content-Range: bytes 0-1048575/<total>`
- Header: `Accept-Ranges: bytes`
- Exactly 1,048,576 bytes returned.

---

## Security Model

1. **Path Lockdown:** Only routes explicitly matching `/health`, `/api/sync`, and `/dl/{token}/{file_id}/{name}` are handled. All other paths return `404 Not Found`.
2. **Zero SSRF:** The Worker never allows user-supplied upstream URLs. All streaming requests strictly target the configured `BACKEND_URL`.
3. **Cryptographic Validation:** Tampered parameters, altered message/chat IDs, and expired tokens are rejected at the edge before any backend traffic is generated.
