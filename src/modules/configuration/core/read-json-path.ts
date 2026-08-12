import type { JsonObject, JsonValue } from "../contracts/configuration-contracts.js";

export type JsonPathReadResult =
  | { found: true; value: JsonValue }
  | { found: false };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonPath(document: JsonObject, path: readonly string[]): JsonPathReadResult {
  let current: JsonValue = document;
  for (const segment of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: structuredClone(current) };
}
