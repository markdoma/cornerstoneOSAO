import asyncio
import importlib.util
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
import httpx

os.environ.update(AO_ORIGIN='https://ao.example', AO_APPLICATION_ORIGIN='https://host.example', AO_WIDGET_ORIGIN='https://widget.example', AO_DEPLOYMENT_ID='dep', AO_INTEGRATION_KEY='key', AO_TENANT_ID='tenant-a')
spec = importlib.util.spec_from_file_location('ao_connector', Path(__file__).resolve().parents[1] / 'integrations/host-connectors/python.py')
import sys
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from fastapi import FastAPI
app = FastAPI(); app.include_router(module.router)

async def main():
    calls = []
    async def exchange(path, payload, token, extra=None):
        calls.append((path, payload, token))
        if path.endswith('/revoke'): return {'ok': True}
        return {'token': 'a' * 43, 'expiresAt': (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(), 'deploymentId': 'dep', 'widgetOrigin': 'https://widget.example'}
    module.ao_request = exchange
    headers = {'Origin': 'https://host.example'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://host.example') as client:
        assert (await client.post('/assistant/session', json={}, headers=headers)).status_code == 401
        assert not calls
        tracked = []
        host = module.HostSession('alice', 'tenant-a', 'native-secret', datetime.now(timezone.utc) + timedelta(seconds=120), lambda: True, tracked.append)
        module.get_verified_host_session = lambda request: host
        r = await client.post('/assistant/session', json={'userId': 'bob', 'tenantId': 'spoof', 'apiToken': 'bad'}, headers=headers)
        assert r.status_code == 200, r.text
        assert calls[-1][1]['userId'] == 'alice'
        assert calls[-1][1]['tenantId'] == 'tenant-a'
        assert calls[-1][1]['apiTokenExpiresAt'].endswith('Z')
        assert 'native-secret' not in r.text and len(tracked) == 1
        host.tenant_id = 'other'
        assert (await client.post('/assistant/session', json={}, headers=headers)).status_code == 403
        host.tenant_id = 'tenant-a'
        checks = iter([True, False]); host.is_active = lambda: next(checks)
        assert (await client.post('/assistant/session', json={}, headers=headers)).status_code == 401
        assert calls[-1][0].endswith('/revoke')
        assert (await client.post('/assistant/session', content='[]', headers={**headers, 'Content-Type': 'application/json'})).status_code == 400
        assert (await client.post('/assistant/session', json={}, headers={'Origin': 'https://evil.example'})).status_code == 403
    print('Python connector: framework execution, identity, tenant, logout and malformed requests passed')
asyncio.run(main())
