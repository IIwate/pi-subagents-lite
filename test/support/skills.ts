import { beforeEach, vi } from "vitest";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
  mockLoadSkills: vi.fn(),
  mockLoadSkillsFromDir: vi.fn(),
  mockFormatSkillsForPrompt: vi.fn(),
}));
export const { mockLoadSkills, mockLoadSkillsFromDir, mockFormatSkillsForPrompt } = mocks;

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  loadSkills: mocks.mockLoadSkills,
  loadSkillsFromDir: mocks.mockLoadSkillsFromDir,
  formatSkillsForPrompt: mocks.mockFormatSkillsForPrompt,
}));

beforeEach(() => {
  mockLoadSkills.mockReset().mockReturnValue({ skills: [], diagnostics: [] });
  mockLoadSkillsFromDir.mockReset().mockReturnValue({ skills: [], diagnostics: [] });
  mockFormatSkillsForPrompt.mockReset().mockReturnValue("");
});

export function makeSkill(
  name: string,
  description: string,
  filePath: string,
  opts: { disableModelInvocation?: boolean } = {},
): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as any,
    disableModelInvocation: opts.disableModelInvocation ?? false,
  };
}
