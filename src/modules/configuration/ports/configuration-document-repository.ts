import type { ConfigurationDocumentSnapshot } from "../contracts/configuration-contracts.js";

export interface ConfigurationDocumentRepository {
  load(): Promise<ConfigurationDocumentSnapshot>;
}
