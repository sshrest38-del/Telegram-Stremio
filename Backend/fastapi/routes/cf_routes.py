import json
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from Backend import db
from Backend.config import Telegram
from Backend.fastapi.security.credentials import require_auth
from Backend.helper.analytics import record_stream_start
from Backend.helper.cf_live import apply_report
from Backend.helper.cf_stream import _hmac, verify_worker_request
from Backend.helper.session_auth import get_active_session_string
from Backend.helper.settings_manager import SettingsManager
from Backend.logger import LOGGER

router = APIRouter(tags=["Cloudflare"])


#----- Only the Cloudflare Worker (holding the shared secret) may call these routes
async def _verified_body(request: Request) -> bytes:
    body = await request.body()
    if not verify_worker_request(
        request.method, request.url.path, body,
        request.headers.get("x-cf-time", ""), request.headers.get("x-cf-sig", ""),
    ):
        raise HTTPException(status_code=401, detail="Bad signature")
    return body


#----- Telegram credentials the Worker needs to stream: API app, bot pool, optional userbot
@router.get("/api/cf/config")
async def cf_config(request: Request):
    await _verified_body(request)
    tokens = [Telegram.BOT_TOKEN, *SettingsManager.current().multi_tokens]
    try:
        user_session = await get_active_session_string() or ""
    except Exception as e:
        LOGGER.warning(f"[CF] Could not load userbot session: {e}")
        user_session = ""
    return {
        "api_id": Telegram.API_ID,
        "api_hash": Telegram.API_HASH,
        "bots": [t for t in dict.fromkeys(tokens) if t],
        "user_session": user_session,
    }


#----- Bytes streamed per token (for daily/monthly limits) and stream-start analytics
@router.post("/api/cf/usage")
async def cf_usage(request: Request):
    data = json.loads(await _verified_body(request) or b"{}")
    for token, delta in (data.get("usage") or {}).items():
        if isinstance(delta, int) and delta > 0:
            try:
                await db.update_token_usage(token, delta)
            except Exception as e:
                LOGGER.error(f"[CF] Usage update failed for token: {e}")
    names = {}
    for start in data.get("starts") or []:
        token = str(start.get("token") or "")
        if not token:
            continue
        if token not in names:
            token_data = await db.get_api_token(token)
            names[token] = token_data.get("name") if token_data else None
        await record_stream_start(token, names[token], str(start.get("ip") or ""), str(start.get("ua") or ""))
    #----- Live streams, so dashboards and user activity show Cloudflare streams too
    if isinstance(data.get("streams"), list) and data.get("member"):
        try:
            await apply_report(str(data["member"]), data.get("client_index"), data.get("dc"), data["streams"])
        except Exception as e:
            LOGGER.error(f"[CF] Live stream report failed: {e}")
    return {"ok": True}


#----- Diagnostics & connection tester for Settings WebUI
@router.post("/api/admin/cf/test-connection")
async def test_cf_connection(request: Request, _: bool = Depends(require_auth)):
    payload = {}
    try:
        payload = await request.json()
    except Exception:
        pass

    url = (payload.get("url") or SettingsManager.current().cf_stream_url or "").rstrip("/")
    secret = (payload.get("secret") or SettingsManager.current().cf_stream_secret or "").strip()

    if not url:
        return {"ok": False, "reachable": False, "message": "Worker URL is required."}

    start_time = time.perf_counter()
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Step 1: Health probe
        try:
            health_res = await client.get(f"{url}/health")
            latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
        except Exception as e:
            return {
                "ok": False,
                "reachable": False,
                "latency_ms": None,
                "message": f"Worker unreachable at {url}: {e}",
            }

        if health_res.status_code != 200:
            return {
                "ok": False,
                "reachable": True,
                "latency_ms": latency_ms,
                "message": f"Worker returned HTTP {health_res.status_code} on /health",
            }

        try:
            info = health_res.json()
        except Exception:
            info = {}

        protocol = info.get("protocol", 1)
        service = info.get("service", "unknown")

        # Step 2: Auth probe (POST /api/sync challenge with secret)
        auth_valid = False
        auth_message = "Secret not provided"
        if secret:
            ts = str(int(time.time()))
            body = "{}"
            sig = _hmac(secret, f"{ts}\nPOST /api/sync\n{body}")
            headers = {
                "x-cf-time": ts,
                "x-cf-sig": sig,
                "content-type": "application/json",
            }
            try:
                sync_res = await client.post(f"{url}/api/sync", content=body, headers=headers)
                if sync_res.status_code == 200:
                    auth_valid = True
                    auth_message = "Secret verified"
                elif sync_res.status_code == 401:
                    auth_valid = False
                    auth_message = "Secret rejected (401 Bad Signature)"
                else:
                    auth_message = f"Auth check returned HTTP {sync_res.status_code}"
            except Exception as e:
                auth_message = f"Auth probe error: {e}"

        return {
            "ok": True if (auth_valid or not secret) else False,
            "reachable": True,
            "latency_ms": latency_ms,
            "service": service,
            "protocol": protocol,
            "auth_valid": auth_valid,
            "message": "Connected successfully! Worker is reachable and shared secret is verified."
            if auth_valid
            else f"Reachable ({latency_ms}ms), {auth_message}",
        }

