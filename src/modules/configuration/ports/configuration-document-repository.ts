import type { ConfigurationDocumentLoadResult, JsonObject } from "../contracts/configuration-contracts.js";

/**
 * Storage access for one persisted configuration document.
 *
 * load reports one of three states: `absent` (strictly ENOENT), `loaded`
 * with the raw document, or `malformed` with a presentable message for any
 * other read failure. It does not throw for expected storage conditions.
 * persist atomically replaces the whole document and throws on failure so
 * the application can keep the previous fragment effective and report an
 * explicit error (REQ-CONFIG-001).
 */
export interface ConfigurationDocumentRepository {
  load(): ConfigurationDocumentLoadResult;
  persist(document: JsonObject): void;
}
