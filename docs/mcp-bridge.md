# Run the MCP bridge

The bridge exposes reviewed application API operations to AO as tools. It calls the existing API as the signed-in user. For a local start, follow [Run with Docker](../README.md#run-with-docker). To install the widget in an app, follow [Install the assistant](host-connectors.md).

## Set up tools

- In **MCP Bridges**, enter the app’s fixed API base URL, exact browser origin, and verified tenant ID. Use one AO workspace per external tenant.
- Upload OpenAPI JSON or YAML up to 5 MB, or add operations manually. Select up to 40 operations for review. Enable only the tools you need.
- Start with a GET read. All other methods require write approval. Classify any GET that changes data as a write as well. If the API takes a user, tenant, or employee field, bind it to the corresponding verified value so the model cannot supply it.
- Choose the host POST session path under **Authentication**. **Validate bridge configuration** checks the bridge. Test the actual host login and API with **Test permitted API tools** inside the signed-in app.
- Publish the bridge and deploy an agent version that uses its tools. To change a live tool or the session path, publish a new bridge and agent version, update the deployment, and replace the widget snippet if its path changed.

## Troubleshoot

| What you see                                 | What to check                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge unavailable                           | Check **MCP Bridges** status and the bridge's `/health/ready` endpoint from its private network. Check PostgreSQL, Redis, and the matching signing keys.                                       |
| Widget missing after sign-in                 | Check the app's session route, login adapter, and deployment key. Follow the [connector troubleshooting steps](host-connectors.md#if-the-widget-stays-hidden).                                 |
| Tool unavailable                             | Check that the published version includes the tool, that it is still enabled, and that the app allows it for this session.                                                                     |
| API rejects a call                           | Check that the API accepts the signed-in user's bearer token and grants access to the target record. Upstream APIs must use public HTTPS. Only enabled local demos use the loopback exception. |
| Write times out or returns an unknown result | Check the record in the app before asking for a new action. AO and the bridge do not automatically retry uncertain writes.                                                                     |
| Redis restarts or loses data                 | The bridge loses its short-lived credentials. Open the assistant again through the host login.                                                                                                 |

## Operate the bridge

Local Docker applies the database migrations at startup. For a separate deployment, apply the Prisma migrations before starting the updated services. Keep the bridge and Redis private, use TLS between services, and disable Redis disk persistence and demo exceptions. Use a restricted bridge database role. The grants are in [bridge-db-role.sql](../scripts/bridge-db-role.sql). Docker can use a separately provisioned role through `AO_DOCKER_BRIDGE_DATABASE_URL`.

**AO backend**

```dotenv
MCP_BRIDGE_ENABLED=true
BRIDGE_URL=http://127.0.0.1:4010
BRIDGE_PRIVATE_KEY_PATH=/secure/ao-bridge-private.pem
BRIDGE_SIGNING_KID=ao-bridge-1
```

**Bridge service**

```dotenv
BRIDGE_DATABASE_URL=postgresql://ao_bridge:REDACTED@database/orchestrator
BRIDGE_REDIS_URL=redis://private-redis:6379
BRIDGE_ENCRYPTION_KEY=<dedicated 64-character hex key>
BRIDGE_PUBLIC_KEY_PATH=/secure/ao-bridge-public.pem
BRIDGE_SIGNING_KID=ao-bridge-1
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=4010
BRIDGE_ALLOWED_HOSTS=localhost,127.0.0.1,bridge
```

The bridge receives only the public signing key. Its `/mcp`, `/control/*`, and health endpoints are for private service traffic. The API token sent by the host is used only for upstream requests. The bridge verifies AO's separate short-lived grant on every call.

To rotate the signing key, pause new bridge actions, let in-flight turns finish or time out, then update the key pair and key ID together and restart both services. Verify a real signed-in read before re-enabling actions. Rotating the Redis encryption key invalidates existing credential bindings, so revoke sessions and have users reconnect. To replace a host integration key, update the app backend with the new key from AO.

## Native development

Use Node.js 22+, PostgreSQL, and nonpersistent Redis. Complete the environment setup in [Run with Docker](../README.md#run-with-docker), then set `DATABASE_URL` and `BRIDGE_DATABASE_URL` in the root `.env` to your native database. Start Redis in its own terminal:

```sh
redis-server --port 56379 --bind 127.0.0.1 --save '' --appendonly no
```

From the repository root, run:

```sh
npm run db:migrate
npm run dev
```

To include the optional Taskboard host, run `ENABLE_DEMO_APP=true npm run dev`.

## Verification

The suites cover MCP discovery and tool calls, authenticated sample CRUD, write approval and replay prevention, tenant/user isolation, malformed operations, ephemeral credential loss, and existing deployment compatibility.

```sh
npm test
npm run typecheck
npm run build

# Use a separate database and a nonpersistent test Redis instance.
DATABASE_URL=postgresql://.../orchestrator_test npm run db:migrate
TEST_DATABASE_URL=postgresql://.../orchestrator_test TEST_REDIS_URL=redis://127.0.0.1:56379 npm run test:integration
TEST_DATABASE_URL=postgresql://.../orchestrator_test TEST_REDIS_URL=redis://127.0.0.1:56379 npm run test:e2e:bridge
```

Browser fixtures use ports 3100/3102/4100/4110 and deterministic model responses with real MCP/HTTP execution. Use the [Taskroom lab](../examples/integration-lab/README.md) to verify a separately built host: signed-out widget hiding, native-user reads, confirmed writes, host refresh, and logout. Production host login and record policies must be validated in that host’s own environment.
