/**
 * resolve-type-name.test.ts — Deterministic Agent type resolution (REQ-AGENT-004).
 *
 * The truth table lives in the catalogue core; registry and tool consume the
 * serializable resolution. Candidate ordering uses code-unit sort so guidance
 * and errors stay byte-stable across platforms.
 */

import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AgentTypeResolutionSchema,
  resolveAgentTypeName,
} from "../../../src/modules/agent-catalogue/public.js";

function entries(...items: Array<{ name: string; displayName?: string }>) {
  return items;
}

describe("REQ-AGENT-004 resolveAgentTypeName truth table", () => {
  it("resolves an exact canonical match even when other names collide case-folded", () => {
    expect(resolveAgentTypeName({
      name: "Explore",
      entries: entries({ name: "Explore" }, { name: "explore" }),
    })).toEqual({ kind: "resolved", name: "Explore", matchedBy: "exact" });
  });

  it("resolves a unique case-folded canonical match", () => {
    expect(resolveAgentTypeName({
      name: "EXPLORE",
      entries: entries({ name: "Explore" }, { name: "reviewer" }),
    })).toEqual({ kind: "resolved", name: "Explore", matchedBy: "case-folded" });
  });

  it("reports ambiguity for a case-folded canonical collision with code-unit sorted candidates", () => {
    expect(resolveAgentTypeName({
      name: "explore",
      entries: entries({ name: "explore-B" }, { name: "Explore-b" }).map((entry) => ({ name: entry.name })),
    })).toEqual({ kind: "not-found" });
    expect(resolveAgentTypeName({
      name: "explore",
      entries: entries({ name: "explore" }, { name: "Explore" }),
    })).toEqual({ kind: "resolved", name: "explore", matchedBy: "exact" });
    expect(resolveAgentTypeName({
      name: "EXPLORE",
      entries: entries({ name: "explore" }, { name: "Explore" }),
    })).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
  });

  it("resolves a unique display-name match only when no canonical matches", () => {
    expect(resolveAgentTypeName({
      name: "friendly reviewer",
      entries: entries({ name: "reviewer", displayName: "Friendly Reviewer" }),
    })).toEqual({ kind: "resolved", name: "reviewer", matchedBy: "display-name" });
  });

  it("reports ambiguity for duplicated display names, deduplicating same canonical targets", () => {
    expect(resolveAgentTypeName({
      name: "helper",
      entries: entries(
        { name: "b-agent", displayName: "Helper" },
        { name: "a-agent", displayName: "helper" },
      ),
    })).toEqual({ kind: "ambiguous", candidates: ["a-agent", "b-agent"] });
  });

  it("lets a canonical match win over a display-name collision", () => {
    expect(resolveAgentTypeName({
      name: "helper",
      entries: entries(
        { name: "Helper" },
        { name: "a-agent", displayName: "helper" },
        { name: "b-agent", displayName: "Helper" },
      ),
    })).toEqual({ kind: "resolved", name: "Helper", matchedBy: "case-folded" });
  });

  it("returns not-found for an empty query or a name that matches nothing", () => {
    expect(resolveAgentTypeName({ name: "", entries: entries({ name: "reviewer" }) }))
      .toEqual({ kind: "not-found" });
    expect(resolveAgentTypeName({ name: "ghost", entries: entries({ name: "reviewer" }) }))
      .toEqual({ kind: "not-found" });
  });
});

describe("REQ-AGENT-004 resolution contract", () => {
  it("round-trips every resolution kind", () => {
    for (const value of [
      { kind: "resolved", name: "a", matchedBy: "exact" },
      { kind: "ambiguous", candidates: ["a", "b"] },
      { kind: "not-found" },
    ]) {
      const revived: unknown = JSON.parse(JSON.stringify(value));
      expect(Check(AgentTypeResolutionSchema, revived)).toBe(true);
    }
  });

  it("rejects invalid resolutions", () => {
    expect(Check(AgentTypeResolutionSchema, { kind: "resolved", name: "", matchedBy: "exact" })).toBe(false);
    expect(Check(AgentTypeResolutionSchema, { kind: "ambiguous", candidates: ["only-one"] })).toBe(false);
    expect(Check(AgentTypeResolutionSchema, { kind: "not-found", extra: 1 })).toBe(false);
  });

  it("throws on invalid queries", () => {
    expect(() => resolveAgentTypeName({ name: 1, entries: [] } as unknown)).toThrow(TypeError);
    expect(() => resolveAgentTypeName({ name: "x", entries: "nope" } as unknown)).toThrow(TypeError);
    expect(() => resolveAgentTypeName({ name: "x", entries: [{ name: "" }] } as unknown)).toThrow(TypeError);
  });
});
