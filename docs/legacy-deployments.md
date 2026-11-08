# Older AO deployments

Use [MCP Bridges](mcp-bridge.md) for new assistants. Existing deployments keep the authentication mode saved on their deployment.

| Mode             | What it does                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bridge-session` | Uses the managed MCP bridge and a short-lived user API token.                                                            |
| `exchange`       | Calls REST directly. AO keeps the encrypted user token in PostgreSQL until expiry or revocation.                         |
| `hris-jwt`       | Verifies the existing HRIS user-context JWT and forwards it to the HRIS internal API with a separate service credential. |

AO assigns a mode from the existing server configuration only when an older deployment is still marked `auto`. Leave `LEGACY_DIRECT_SETUP_ENABLED` off for new integrations.

## Keep an existing HRIS JWT deployment running

Keep its `data-auth="hris-jwt"` snippet and cookie-authenticated GET route, usually `/api/internal/chat/session`. Keep these AO settings together:

- `FIRST_PARTY_JWKS_URL` and `FIRST_PARTY_TENANT_ORGS` for signing keys and tenant mapping.
- `HRIS_INTERNAL_API_BASE_URL` and `AO_SERVICE_TOKEN` for calls to the existing internal API.

AO verifies issuer, audience, expiry, and `tool:operation_name` scopes. The internal API must verify the service and user credentials and check tenant and record access. Revocation for this mode is local to the AO process. Plan around JWT expiry and your host session policy.

## Move a direct deployment to MCP

1. In **MCP Bridges**, choose **Migrate an existing direct API connection** to copy its tools to a draft.
2. Review and publish the bridge. Create a new agent version that uses the bridge tools.
3. Update the deployment to the new version. Install its host connector and replace the embed snippet.
4. Test sign-in, an allowed read, and logout in the host app.

Switching versions revokes existing widget sessions. To roll back, restore the prior deployment version, host settings, and snippet. Completed changes to the application's records remain in effect.
