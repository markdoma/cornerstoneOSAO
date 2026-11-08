export type HostSession = {
  userId: string;
  /** Required for MCP bridge deployments; derive from verified active tenant membership. */
  tenantId?: string;
  employeeId?: string;
  apiToken: string;
  expiresAt: string;
  /** Omit to use published, enabled tools. Supply [] to explicitly deny all tools. */
  toolIds?: string[];
  /** Recheck the verified host session, including logout and assistant authorization. */
  isActive: () => boolean | Promise<boolean>;
};
export type WidgetAccess = {
  token: string;
  expiresAt: string;
  deploymentId: string;
  widgetOrigin: string;
};
export function createRelaySessionHandler(options: {
  relayOrigin: string;
  widgetOrigin?: string;
  applicationOrigin: string;
  deploymentId: string;
  integrationKey: string;
  allowLocalhost?: boolean;
  getSession: (request: Request) => Promise<HostSession | null>;
  onSessionIssued?: (widget: WidgetAccess, session: HostSession) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}): (request: Request) => Promise<Response>;
