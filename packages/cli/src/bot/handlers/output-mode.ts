import type { InboundMessage } from "../../channel/types";
import type {
  ChatOutputPreferences,
  ThinkingMode,
  ToolCallMode,
  ToolResultMode,
  TranscriptOutputPreset,
  TranscriptOutputPresetLabel,
} from "../../config/schema";
import type { RouterContext } from "../command-router";
import {
  applyChatTranscriptPreset,
  getChatOutputPreferences,
  getChatTranscriptPresetLabel,
  setChatOutputPreferences,
} from "../../config/schema";
import { saveConfig } from "../../config/store";
import type { PendingOutputModeOption } from "../../session/manager";

const PRESET_CHOICES: Array<{ value: TranscriptOutputPreset | "custom"; label: string }> = [
  { value: "simple", label: "Simple" },
  { value: "thinking", label: "Thinking" },
  { value: "verbose", label: "Verbose" },
  { value: "custom", label: "Custom" },
];

const THINKING_CHOICES: Array<{ value: ThinkingMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "preview", label: "Preview" },
  { value: "full", label: "Full" },
];

const TOOL_CALL_CHOICES: Array<{ value: ToolCallMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "compact", label: "Compact" },
  { value: "detailed", label: "Detailed" },
];

const TOOL_RESULT_CHOICES: Array<{ value: ToolResultMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "compact", label: "Compact" },
  { value: "full", label: "Full" },
];

const BOOLEAN_CHOICES: Array<{ value: boolean; label: string }> = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function formatPresetLabel(value: TranscriptOutputPresetLabel): string {
  return value;
}

function formatOutputSummary(output: ChatOutputPreferences, preset: TranscriptOutputPresetLabel): string {
  const transcript = `Transcript preset: ${formatPresetLabel(preset)}`;
  return [
    transcript,
    `Thinking: ${output.thinkingMode}` ,
    `Tool calls: ${output.toolCallMode}` ,
    `Tool results: ${output.toolResultMode}` ,
    `Tool errors: ${output.toolErrors ? "on" : "off"}` ,
    `Background jobs: ${output.backgroundJobs ? "on" : "off"}` ,
    `Typing indicator: ${output.typingIndicator ? "on" : "off"}` ,
  ].join("\n");
}

function usageText(): string {
  return [
    "Usage:",
    "/output_mode simple|thinking|verbose",
    "/output_mode thinking off|preview|full",
    "/output_mode tool_calls off|compact|detailed",
    "/output_mode tool_results off|compact|full",
    "/output_mode tool_errors on|off",
    "/output_mode background_jobs on|off",
    "/output_mode typing on|off",
  ].join("\n");
}

function parseBooleanToken(value: string): boolean | null {
  if (value === "on") return true;
  if (value === "off") return false;
  return null;
}

function parseOutputModeArgs(modeArg: string):
  | { kind: "preset"; value: TranscriptOutputPreset }
  | { kind: "thinkingMode"; value: ThinkingMode }
  | { kind: "toolCallMode"; value: ToolCallMode }
  | { kind: "toolResultMode"; value: ToolResultMode }
  | { kind: "toolErrors"; value: boolean }
  | { kind: "backgroundJobs"; value: boolean }
  | { kind: "typingIndicator"; value: boolean }
  | null {
  const parts = modeArg.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (parts.length === 1) {
    if (parts[0] === "simple" || parts[0] === "thinking" || parts[0] === "verbose") {
      return { kind: "preset", value: parts[0] as TranscriptOutputPreset };
    }
    return null;
  }
  if (parts.length !== 2) return null;
  const [setting, value] = parts;
  if (setting === "thinking") {
    if (value === "off" || value === "preview" || value === "full") return { kind: "thinkingMode", value };
    return null;
  }
  if (setting === "tool_calls") {
    if (value === "off" || value === "compact" || value === "detailed") return { kind: "toolCallMode", value };
    return null;
  }
  if (setting === "tool_results") {
    if (value === "off" || value === "compact" || value === "full") return { kind: "toolResultMode", value };
    return null;
  }
  if (setting === "tool_errors") {
    const parsed = parseBooleanToken(value);
    return parsed === null ? null : { kind: "toolErrors", value: parsed };
  }
  if (setting === "background_jobs") {
    const parsed = parseBooleanToken(value);
    return parsed === null ? null : { kind: "backgroundJobs", value: parsed };
  }
  if (setting === "typing") {
    const parsed = parseBooleanToken(value);
    return parsed === null ? null : { kind: "typingIndicator", value: parsed };
  }
  return null;
}

function applySingleOutputSetting(
  current: ChatOutputPreferences,
  action: Exclude<ReturnType<typeof parseOutputModeArgs>, null | { kind: "preset" }>
 ): ChatOutputPreferences {
  return { ...current, [action.kind]: action.value };
}

export function buildOutputPickerPrompt(step: PendingOutputModeOption["kind"] | "preset", output: ChatOutputPreferences): {
  title: string;
  options: PendingOutputModeOption[];
  optionLabels: string[];
} {
  switch (step) {
    case "preset":
      return {
        title: "Select transcript mode",
        options: PRESET_CHOICES.map((choice) => ({ kind: "preset", value: choice.value })),
        optionLabels: PRESET_CHOICES.map((choice) => choice.label),
      };
    case "thinkingMode":
      return {
        title: `Thinking (current: ${output.thinkingMode})`,
        options: THINKING_CHOICES.map((choice) => ({ kind: "thinkingMode", value: choice.value })),
        optionLabels: THINKING_CHOICES.map((choice) => choice.label),
      };
    case "toolCallMode":
      return {
        title: `Tool calls (current: ${output.toolCallMode})`,
        options: TOOL_CALL_CHOICES.map((choice) => ({ kind: "toolCallMode", value: choice.value })),
        optionLabels: TOOL_CALL_CHOICES.map((choice) => choice.label),
      };
    case "toolResultMode":
      return {
        title: `Tool results (current: ${output.toolResultMode})`,
        options: TOOL_RESULT_CHOICES.map((choice) => ({ kind: "toolResultMode", value: choice.value })),
        optionLabels: TOOL_RESULT_CHOICES.map((choice) => choice.label),
      };
    case "toolErrors":
      return {
        title: `Tool errors (current: ${output.toolErrors ? "on" : "off"})`,
        options: BOOLEAN_CHOICES.map((choice) => ({ kind: "toolErrors", value: choice.value })),
        optionLabels: BOOLEAN_CHOICES.map((choice) => choice.label),
      };
    case "backgroundJobs":
      return {
        title: `Background jobs (current: ${output.backgroundJobs ? "on" : "off"})`,
        options: BOOLEAN_CHOICES.map((choice) => ({ kind: "backgroundJobs", value: choice.value })),
        optionLabels: BOOLEAN_CHOICES.map((choice) => choice.label),
      };
    case "typingIndicator":
      return {
        title: `Typing indicator (current: ${output.typingIndicator ? "on" : "off"})`,
        options: BOOLEAN_CHOICES.map((choice) => ({ kind: "typingIndicator", value: choice.value })),
        optionLabels: BOOLEAN_CHOICES.map((choice) => choice.label),
      };
  }
}

export function getNextOutputWizardStep(step: Exclude<PendingOutputModeOption["kind"], "preset">): Exclude<PendingOutputModeOption["kind"], "preset"> | null {
  switch (step) {
    case "thinkingMode": return "toolCallMode";
    case "toolCallMode": return "toolResultMode";
    case "toolResultMode": return "toolErrors";
    case "toolErrors": return "backgroundJobs";
    case "backgroundJobs": return "typingIndicator";
    case "typingIndicator": return null;
  }
}

export function buildOutputModeSummaryMessage(chatId: string, config: RouterContext["config"], fmt: RouterContext["channel"]["fmt"]): string {
  const output = getChatOutputPreferences(config, chatId);
  const preset = getChatTranscriptPresetLabel(config, chatId);
  return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Output settings"))}\n${fmt.escape(formatOutputSummary(output, preset))}`;
}

export async function handleOutputModeCommand(
  msg: InboundMessage,
  modeArg: string | undefined,
  ctx: RouterContext
): Promise<void> {
  const { fmt } = ctx.channel;
  const current = getChatOutputPreferences(ctx.config, msg.chatId);

  if (!modeArg) {
    await ctx.channel.send(msg.chatId, buildOutputModeSummaryMessage(msg.chatId, ctx.config, fmt));
    if (ctx.channel.sendPoll) {
      const picker = buildOutputPickerPrompt("preset", current);
      const sent = await ctx.channel.sendPoll(msg.chatId, picker.title, picker.optionLabels, false);
      ctx.sessionManager.registerOutputModePicker({
        pollId: sent.pollId,
        messageId: sent.messageId,
        chatId: msg.chatId,
        ownerUserId: msg.userId,
        step: "preset",
        options: picker.options,
      });
      return;
    }
    await ctx.channel.send(msg.chatId, fmt.escape(usageText()));
    return;
  }

  const parsed = parseOutputModeArgs(modeArg);
  if (!parsed) {
    await ctx.channel.send(msg.chatId, `${fmt.escape(usageText())}\n\n${fmt.escape(formatOutputSummary(current, getChatTranscriptPresetLabel(ctx.config, msg.chatId)))}`);
    return;
  }

  let changed = false;
  if (parsed.kind === "preset") {
    changed = applyChatTranscriptPreset(ctx.config, msg.chatId, parsed.value);
  } else {
    changed = setChatOutputPreferences(ctx.config, msg.chatId, applySingleOutputSetting(current, parsed));
  }
  if (changed) await saveConfig(ctx.config);

  await ctx.channel.send(msg.chatId, buildOutputModeSummaryMessage(msg.chatId, ctx.config, fmt));
}
