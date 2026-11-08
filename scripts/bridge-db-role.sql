-- Run as the PostgreSQL administrator in the AO database. Set the ao_bridge login
-- password via your secret manager separately; this file contains no credentials.
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ao_bridge') THEN CREATE ROLE ao_bridge LOGIN; END IF; END $$;
GRANT USAGE ON SCHEMA public TO ao_bridge;
GRANT SELECT ON "Bridge", "BridgeRevision", "BridgeTenant" TO ao_bridge;
GRANT SELECT ("id","orgId","active","versionId","authMode") ON "Deployment" TO ao_bridge;
GRANT SELECT ("id","orgId","userId","deploymentId","versionId","tenantId","revokedAt","expiresAt","toolIds","credentialHandle","employeeId") ON "WidgetSession" TO ao_bridge;
GRANT SELECT ("id","orgId","enabled","bridgeRevisionId","bridgeOperationId") ON "Tool" TO ao_bridge;
GRANT SELECT,INSERT,UPDATE ON "BridgeExecution" TO ao_bridge;
-- Do not grant User, DashboardSession, PasswordReset, Message, or legacy credential columns.
