import { describe, expect, it } from "vitest";
import { paintLines, paintParts } from "../../../src/platform/pi/tui/paint.js";
import { makeTheme } from "./fixtures.js";

describe("REQ-CHILD-003 Pi paint contract", () => {
  it("routes color roles through theme.fg and bold through theme.bold", () => {
    const theme = makeTheme();
    const painted = paintParts([
      { text: "◇", color: "accent" },
      { text: " " },
      { text: "Main", bold: true },
      { text: "Blocked", color: "warning", bold: true },
    ], theme);

    expect(painted).toBe("◇ MainBlocked");
    expect(theme.fg).toHaveBeenCalledWith("accent", "◇");
    expect(theme.fg).toHaveBeenCalledWith("warning", "Blocked");
    expect(theme.fg).not.toHaveBeenCalledWith("dim", "◇");
    expect(theme.bold).toHaveBeenCalledWith("Main");
    expect(theme.bold).toHaveBeenCalledWith("Blocked");
  });

  it("paints each projected line into one terminal row", () => {
    const theme = makeTheme();
    expect(paintLines([
      { parts: [{ text: "row one" }] },
      { parts: [{ text: "row " }, { text: "two", color: "dim" }] },
    ], theme)).toEqual(["row one", "row two"]);
  });
});
