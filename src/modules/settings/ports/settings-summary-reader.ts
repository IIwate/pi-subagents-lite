import type { RootSummaries } from "../contracts/settings-contracts.js";

/**
 * Live policy summaries for the root page. Read on every root render so the
 * rows reflect changes made inside a category without caching policy here.
 */
export interface SettingsSummaryReader {
  read(): RootSummaries;
}
