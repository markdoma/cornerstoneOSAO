"""Python 3.11+, FastAPI. Save as ao_connector.py and include router in your app.
pip install fastapi httpx
Keep the existing session middleware/CSRF protection. Never log credentials.
"""
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Callable, Optional
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

@dataclass
class HostSession:
    user_id: str
    tenant_id: str
    api_token: str
    expires_at: datetime
    is_active: Callable[[], bool]  # Recheck the same server login and active tenant.
    on_issued: Callable[[dict], None]  # Store by login session for server logout revocation.
    employee_id: Optional[str] = None
    tool_ids: Optional[list[str]] = None

def get_verified_host_session(request: Request) -> Optional[HostSession]:
    # REQUIRED: resolve your existing verified web session and assistant permission.
    # Obtain a native user bearer token accepted by your existing application APIs.
    # Never derive these values from request JSON or unverified token claims.
    return None

def origin(name, fallback=None):
    value = os.environ.get(name, fallback)
    u = urlsplit(value or '')
    local = os.environ.get('AO_ALLOW_LOCALHOST') == 'true' and u.hostname in ('localhost', '127.0.0.1', '::1')
    if not value or value != f'{u.scheme}://{u.netloc}' or u.username or u.password or (u.scheme != 'https' and not (local and u.scheme == 'http')):
        raise ValueError('Configure exact HTTPS origins; localhost HTTP requires explicit development opt-in')
    return value

AO = origin('AO_ORIGIN')
APP = origin('AO_APPLICATION_ORIGIN')
WIDGET = origin('AO_WIDGET_ORIGIN', AO)
DEPLOYMENT = os.environ['AO_DEPLOYMENT_ID']
KEY = os.environ['AO_INTEGRATION_KEY']
TENANT = os.environ['AO_TENANT_ID']
PATH = os.environ.get('AO_SESSION_ENDPOINT', '/assistant/session')
router = APIRouter()

def result(status, body):
    return JSONResponse(body, status_code=status, headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

async def ao_request(path, payload, token, extra=None):
    headers = {'Authorization': 'Bearer ' + token, **(extra or {})}
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        async with client.stream('POST', AO + path, json=payload, headers=headers) as response:
            if response.status_code != 200:
                raise ValueError('Assistant unavailable')
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > 16000:
                    raise ValueError('Assistant response too large')
            return json.loads(raw)

async def revoke_ao_session(widget_token):
    await ao_request('/v1/widget/revoke', {}, widget_token, {'X-Host-Origin': APP})

@router.post(PATH)
async def assistant_session(request: Request):
    if request.headers.get('origin') != APP:
        return result(403, {'error': 'Invalid application origin'})
    if not request.headers.get('content-type', '').lower().startswith('application/json'):
        return result(415, {'error': 'Use application/json'})
    issued = None
    try:
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 2048:
                return result(413, {'error': 'Request too large'})
        try:
            body = json.loads(raw or b'{}')
        except (json.JSONDecodeError, UnicodeDecodeError):
            return result(400, {'error': 'Invalid JSON'})
        if not isinstance(body, dict):
            return result(400, {'error': 'Invalid JSON object'})
        if body.get('deploymentId', DEPLOYMENT) != DEPLOYMENT:
            return result(403, {'error': 'Deployment denied'})
        host = get_verified_host_session(request)
        now = datetime.now(timezone.utc)
        if not host or not host.user_id or not host.api_token or '\r' in host.api_token or '\n' in host.api_token or not callable(host.is_active) or not callable(host.on_issued) or host.expires_at <= now + timedelta(seconds=5) or not host.is_active():
            return result(401, {'error': 'Sign in to use the assistant'})
        if host.tenant_id != TENANT:
            return result(403, {'error': 'Tenant denied'})
        payload = dict(deploymentId=DEPLOYMENT, userId=host.user_id, tenantId=host.tenant_id, origin=APP, apiToken=host.api_token, apiTokenExpiresAt=host.expires_at.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'))
        if host.employee_id is not None:
            payload['employeeId'] = host.employee_id
        if host.tool_ids is None:
            payload['useDeploymentTools'] = True
        else:
            payload['toolIds'] = host.tool_ids
        access = await ao_request('/v1/widget-sessions', payload, KEY)
        expiry = datetime.fromisoformat(access['expiresAt'].replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', access.get('token', '')) or access.get('deploymentId') != DEPLOYMENT or access.get('widgetOrigin') != WIDGET or not now < expiry <= min(host.expires_at, now + timedelta(minutes=5)):
            raise ValueError('Invalid assistant response')
        issued = {k: access[k] for k in ('token', 'expiresAt', 'deploymentId', 'widgetOrigin')}
        if not host.is_active():
            await revoke_ao_session(issued['token'])
            issued = None
            return result(401, {'error': 'Host session ended'})
        host.on_issued(issued)
        return result(200, issued)
    except Exception:
        if issued:
            try:
                await revoke_ao_session(issued['token'])
            except Exception:
                pass  # Keep tokens out of logs; expiry is fallback. Disable deployment if needed.
        return result(502, {'error': 'Assistant connection unavailable'})

# Mount in your existing FastAPI app (after normal session middleware):
# from ao_connector import router
# app.include_router(router)
# On host logout: await revoke_ao_session(token) for each tracked widget token.
