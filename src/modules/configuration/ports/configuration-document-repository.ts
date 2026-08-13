import type { JsonObject } from "../contracts/configuration-contracts.js";

/**
 * Storage access for the one persisted configuration document.
 *
 * load returns the raw document and resolves unreadable storage to an empty
 * document (approved startup behavior). persist atomically replaces the whole
 * document and throws on failure so the application can keep the previous
 * fragment effective and report an explicit error (REQ-CONFIG-001).
 */
export interface ConfigurationDocumentRepository {
  load(): JsonObject;
  persist(document: JsonObject): void;
}
