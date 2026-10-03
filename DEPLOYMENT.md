# TELEGRAM-STREMIO CLOUDFLARE STREAMING DEPLOYMENT GUIDE

This guide walks you through deploying your own self-hosted Cloudflare Streaming Worker and integrating it with your Telegram-Stremio instance.

---

## Part 1: Cloudflare Worker Deployment

### Step 1: Install Dependencies
Open your terminal in the `cloudflare-worker` directory:
```bash
cd cloudflare-worker
npm install
```

### Step 2: Configure Backend URL
Open `wrangler.jsonc` and replace `BACKEND_URL` with your public Telegram-Stremio address (e.g. your Koyeb, Render, VPS, or custom domain):
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

### Step 3: Authenticate with Cloudflare
If not already logged in:
```bash
npx wrangler login
```

### Step 4: Configure Shared Secret
Generate a strong random secret (at least 32 characters), for example using openssl:
```bash
openssl rand -hex 32
```
Save this secret into Cloudflare Worker encrypted secrets:
```bash
npx wrangler secret put SHARED_SECRET
```
*Paste your generated secret when prompted.*

### Step 5: Deploy the Worker
Deploy your Worker to Cloudflare:
```bash
npm run deploy
```
Upon successful deployment, Wrangler outputs your Worker URL:
```text
Published telegram-stremio-streaming-worker (X.XX sec)
  https://telegram-stremio-streaming-worker.your-subdomain.workers.dev
```

### Step 6: Verify Worker Health
Test that your deployed Worker is responding:
```bash
curl https://telegram-stremio-streaming-worker.your-subdomain.workers.dev/health
```
Expected output:
```json
{
  "ok": true,
  "service": "telegram-stremio-worker",
  "protocol": 1,
  "version": "1.0.0"
}
```

---

## Part 2: Telegram-Stremio Backend Configuration

1. Log in to your Telegram-Stremio Web UI (`https://your-telegram-stremio.koyeb.app/login`).
2. Navigate to **Settings** in the left sidebar.
3. Scroll down to the **Cloudflare Streaming** section.
4. Fill in the fields:
   - **Worker URL:** `https://telegram-stremio-streaming-worker.your-subdomain.workers.dev` (omit trailing slash).
   - **Shared Secret:** The exact secret you entered during `npx wrangler secret put SHARED_SECRET`.
   - **Stremio Links:**
     - Select **Both** initially while testing (this provides both the direct link and a `(Cloudflare)` stream option in Stremio).
     - Once verified, switch to **Cloudflare only**.
5. Click the **Test Connection** button:
   - The app immediately tests connectivity, measures round-trip latency, verifies protocol v1 compatibility, and confirms that the shared secret is accepted.
6. Click **Save Settings**.

---

## Part 3: Stremio & Nuvio Playback Verification

### 1. Stremio Addon Test
1. Open Stremio.
2. In the addon search or installed addons, install or reload your addon:
   `https://your-telegram-stremio.koyeb.app/stremio/<YOUR_TOKEN>/manifest.json`
3. Click on any indexed movie or series.
4. Verify that the stream list shows:
   - If mode is **Both**: `[Stream Name] (Cloudflare)` and `[Stream Name] (Direct)`.
   - If mode is **Cloudflare only**: `[Stream Name]`.
5. Click to play the Cloudflare stream.
6. Perform random seeks:
   - Seek forward 10 minutes.
   - Seek forward 45 minutes.
   - Seek backward.
7. Verify that video playback resumes immediately (low TTFB, instant seek).

### 2. Nuvio Test
1. In Nuvio, open the addon settings and add your addon manifest URL.
2. Open a movie detail page.
3. Start streaming and verify subtitle tracks, audio tracks, and full seeking support.

---

## Part 4: Platform Deployment Instructions

### A. Koyeb
1. In Koyeb dashboard, create a new Web Service from Dockerfile or GitHub repository (`https://github.com/weebzone/Telegram-Stremio`).
2. Set Environment Variables:
   - `PORT`: `8000`
   - `API_ID`: Your Telegram API ID
   - `API_HASH`: Your Telegram API Hash
   - `BOT_TOKEN`: Primary bot token
   - `OWNER_ID`: Your Telegram User ID
   - `DATABASE`: MongoDB tracking & storage URIs (comma-separated)
3. Deploy the service.
4. Copy the Koyeb app domain (e.g. `https://my-app.koyeb.app`) into `wrangler.jsonc` as `BACKEND_URL`.

### B. Render
1. Click **Deploy to Render** using `render.yaml`.
2. Configure required environment variables (`API_ID`, `API_HASH`, `BOT_TOKEN`, `OWNER_ID`, `DATABASE`).
3. Deploy the web service.
4. Copy the onrender.com domain into `wrangler.jsonc` as `BACKEND_URL`.

### C. Docker / VPS
1. Clone the repository and configure `config.env`:
   ```bash
   git clone https://github.com/weebzone/Telegram-Stremio.git
   cd Telegram-Stremio
   cp sample_config.env config.env
   nano config.env
   ```
2. Start the service with Docker Compose:
   ```bash
   docker compose up -d --build
   ```
3. Set `BACKEND_URL` in `wrangler.jsonc` to your VPS domain or public IP with HTTPS reverse proxy.

---

## Part 5: Secret Rotation Procedure

To rotate your shared secret without interrupting active video streams:
1. In your Cloudflare Worker directory:
   ```bash
   # Set the current secret as the previous secret
   npx wrangler secret put PREVIOUS_SHARED_SECRET
   # Enter the old secret value

   # Put the new secret as SHARED_SECRET
   npx wrangler secret put SHARED_SECRET
   # Enter the new secret value
   ```
2. In Telegram-Stremio Web UI:
   - Go to **Settings** -> **Cloudflare Streaming**.
   - Update **Shared Secret** with the new secret.
   - Click **Test Connection** -> **Save Settings**.
3. Streams generated with the old secret will continue playing smoothly until their 48-hour links expire.
4. After 48 hours, remove the old secret:
   ```bash
   npx wrangler secret delete PREVIOUS_SHARED_SECRET
   ```

---

## Part 6: Rollback Procedure

If you ever need to disable Cloudflare Streaming:
1. Open **Settings** -> **Cloudflare Streaming** in the Telegram-Stremio Web UI.
2. Change **Stremio Links** to **Off — stream from this server**.
3. Click **Save Settings**.
4. All Stremio streams immediately revert to direct server streaming.
