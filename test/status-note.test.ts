import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for status without a note", () => {
    expect(getStatusNote({ status: "completed", startedAt: 0 })).toBe("");
  });

  it("returns user stop message when stoppedBy is user", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/STOPPED BY THE USER/);
  });

  it("returns agent stop message when stoppedBy is agent", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "agent" })).toMatch(/stopped before completion/);
  });

  it("returns agent stop message when stoppedBy is undefined", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0 })).toMatch(/stopped before completion/);
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/^ \(.+\)$/);
  });

  it("tells the parent a hard abort produced no answer and how to recover", () => {
    // A hard abort is the only terminal state nobody chose, and it usually
    // carries no text at all — the note is the parent's entire signal, so it
    // must say there is no result, warn off any fragment, and give a remedy.
    const note = getStatusNote({ status: "aborted", startedAt: 0 });
    expect(note).toMatch(/HARD-STOPPED/);
    expect(note).toMatch(/without producing a final answer/);
    expect(note).toMatch(/not a conclusion/);
    expect(note).toMatch(/max_turns/);
  });

  it("keeps the soft turn limit distinct from a hard abort", () => {
    // turn_limited means the agent did wrap up inside the grace window, so it
    // must not inherit the hard-abort "no final answer" wording.
    const note = getStatusNote({ status: "turn_limited", startedAt: 0 });
    expect(note).toMatch(/wrapped up at the turn limit/);
    expect(note).not.toMatch(/HARD-STOPPED/);
  });
});
