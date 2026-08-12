import type {
  AgentSourceLoadRequest,
  AgentSourceLoadResult,
} from "../contracts/catalogue-contracts.js";

export interface AgentCatalogueRepository {
  load(request: AgentSourceLoadRequest): Promise<AgentSourceLoadResult>;
}
