import type { JsonObject, JsonValue } from "../contracts/configuration-contracts.js";

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assign with defineProperty so JSON-sourced keys like "__proto__" become own
 * enumerable entries instead of prototype mutations.
 */
function setOwn(record: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

/**
 * Produce the next document with one section's assignments applied and the
 * named removals deleted. A non-object section on disk is replaced instead of
 * merged: capability normalizers already treat it as absent, so preserving it
 * would keep unreadable data forever. Removing the last key keeps an empty
 * section object — the commit only touches submitted content, and an empty
 * section is semantically inert.
 */
export function applyFragmentAssignments(
  document: JsonObject,
  section: string,
  assignments: Readonly<Record<string, JsonValue>>,
  removals: readonly string[] = [],
): JsonObject {
  const next = structuredClone(document);
  const existing = next[section];
  const target: Record<string, JsonValue> = isPlainObject(existing) ? existing : {};
  for (const key of removals) {
    delete target[key];
  }
  for (const key of Object.keys(assignments)) {
    setOwn(target, key, structuredClone(assignments[key]!));
  }
  setOwn(next, section, target);
  return next;
}
