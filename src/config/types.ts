/** Non-model keys in config.agent — preserved when clearing all overrides. */
export const CONFIG_AGENT_NON_MODEL_KEYS = [
  "default",
  "forceBackground",
  "graceTurns",
  "showCost",
  "showTools",
  "showTurns",
  "showInput",
  "showOutput",
  "showContext",
  "showTime",
  "deltaInputTokens",
  // The widget* settings were removed with the tree renderer. Keep their keys so legacy
  // config entries are not mistaken for per-agent model overrides by clearAllModelOverrides.
  "widgetMaxLines",
  "widgetMaxLinesCompact",
  "widgetDescLengthFull",
  "widgetDescLengthCompact",
  "widgetCompact",
  "widgetShortcut",
  "systemPromptMode",
  "includeContextFiles",
  "defaultThinking",
  "defaultMaxTurns",
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
  "disableDefaultAgents",
];
