/**
 * Corpus size wording for the tool description and replies. Fixed text per source:
 * the catalogue database (1,396,476 cars on Oct 12, 2026) or the live catalogue API.
 */

import { configuredMode } from "./source-mode";

export function getCorpusCountForDescription(): string {
  return configuredMode() === "edmunds_catalog" ? "about 1.3 million" : "about 1.4 million";
}
