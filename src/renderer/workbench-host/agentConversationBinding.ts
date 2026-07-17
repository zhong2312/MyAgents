import { normalizeWorkspacePathIdentity } from "../../shared/workspacePath";

const STORAGE_PREFIX = "myagents.workbench.agent-conversation.v1";

function storageKey(
  workbenchId: string,
  workspacePath: string,
  conversationKey: string,
): string {
  return [
    STORAGE_PREFIX,
    encodeURIComponent(workbenchId),
    encodeURIComponent(normalizeWorkspacePathIdentity(workspacePath)),
    encodeURIComponent(conversationKey),
  ].join(":");
}

export function loadWorkbenchAgentConversation(
  workbenchId: string,
  workspacePath: string,
  conversationKey: string,
): string | null {
  try {
    return window.localStorage.getItem(
      storageKey(workbenchId, workspacePath, conversationKey),
    );
  } catch {
    return null;
  }
}

export function saveWorkbenchAgentConversation(
  workbenchId: string,
  workspacePath: string,
  conversationKey: string,
  sessionId: string,
): void {
  try {
    const key = storageKey(workbenchId, workspacePath, conversationKey);
    if (window.localStorage.getItem(key) !== sessionId) {
      window.localStorage.setItem(key, sessionId);
    }
  } catch {
    // Storage can be unavailable in hardened WebViews; the live surface still works.
  }
}

export function clearWorkbenchAgentConversation(
  workbenchId: string,
  workspacePath: string,
  conversationKey: string,
): void {
  try {
    window.localStorage.removeItem(
      storageKey(workbenchId, workspacePath, conversationKey),
    );
  } catch {
    // See saveWorkbenchAgentConversation.
  }
}
