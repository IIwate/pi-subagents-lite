import type { SubagentPromptRequest } from "../contracts/prompt-contracts.js";

function escapeXml(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripScaffolding(prompt: string): string {
  let result = prompt;
  result = result.replace(/\n?<\s*project_context\s*>[\s\S]*?<\/\s*project_context\s*>\n?/g, "\n");
  result = result.replace(/\n?(?:The following skills provide[\s\S]*?)?<\s*available_skills\s*>[\s\S]*?<\/\s*available_skills\s*>\n?/g, "\n");
  result = result.replace(/\n?Current date:.*\n?/g, "\n");
  result = result.replace(/\n?Current working directory:.*\n?/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Inherit asked for a persona the user cannot see or correct. Whitespace
 * and a header that is only parent scaffolding are the same absence as
 * `null`: after the strip there is nothing to show, and falling through
 * to the generic Pi header would still be reported as inherit. Custom is
 * different — the file is a settings page the user already owns — so a
 * missing header is left for the replace fallback the host announced.
 * Revisit if inherit snapshots the parent text at queue time instead of
 * asking the host when the run starts.
 */
export function isVisiblePromptHeader(header: string | null | undefined): header is string {
  return typeof header === "string" && stripScaffolding(header).length > 0;
}

export function assembleSubagentPromptText(request: SubagentPromptRequest): string {
  const envLines = [
    "# Environment",
    `Working directory: ${request.cwd}`,
    request.env.isGitRepo ? "Git repository: yes" : "Not a git repository",
  ];
  if (request.env.isGitRepo && request.env.branch) {
    envLines.push(`Branch: ${request.env.branch}`);
  }
  envLines.push(`Platform: ${request.env.platform}`);
  const envBlock = envLines.join("\n");

  let extrasSuffix = "";
  if (request.skillElements.length > 0) {
    extrasSuffix = `\n\n${[
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
      ...request.skillElements,
      "</available_skills>",
    ].join("\n")}`;
  }

  const agentInstructions = `\n<agent_instructions>\n${request.agentInstructions}\n</agent_instructions>`;
  let contextSuffix = "";
  if (request.contextFiles.length > 0) {
    const lines = [
      "<project_context>",
      "",
      "Project-specific instructions and guidelines:",
      "",
    ];
    for (const file of request.contextFiles) {
      lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
      lines.push(file.content);
      lines.push("</project_instructions>");
      lines.push("");
    }
    lines.push("</project_context>");
    contextSuffix = `\n\n${lines.join("\n")}`;
  }

  let customHeader: string | undefined;
  if (request.mode === "inherit") {
    if (!isVisiblePromptHeader(request.header)) {
      throw new TypeError("Inherited parent prompt is unavailable.");
    }
    customHeader = stripScaffolding(request.header);
  } else if (request.mode === "custom" && isVisiblePromptHeader(request.header)) {
    customHeader = stripScaffolding(request.header);
  }
  const basePrompt = customHeader
    ? `${customHeader}\n\n${envBlock}`
    : `You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously.\n\n${envBlock}`;
  return `${basePrompt}${contextSuffix}\n<active_agent name="${request.agentName}"/>\n${agentInstructions}${extrasSuffix}`;
}
