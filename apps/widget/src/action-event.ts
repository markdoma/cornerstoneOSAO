export type CompletedActionDetail = { deploymentId: string; actionId: string; toolId: string };
/** Return metadata only. Never propagate API payloads, credentials, or arbitrary iframe fields. */
export function completedActionDetail(
  message: unknown,
  deploymentId: string,
): CompletedActionDetail | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (
    value.type !== 'orchestrator:action-completed' ||
    value.deploymentId !== deploymentId ||
    typeof value.actionId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.actionId) ||
    typeof value.toolId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.toolId)
  )
    return null;
  return { deploymentId, actionId: value.actionId, toolId: value.toolId };
}
