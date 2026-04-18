import type { Formatter } from "../../channel/formatter";
import type { InboundMessage } from "../../channel/types";
import type {
  ChatDeliveryPreference,
  PermanentMuteDeliveryPreference,
  ThrottleDeliveryPreference,
  TimedMuteDeliveryPreference,
  ThrottleIntervalMinutes,
  TimedMuteDurationMinutes,
} from "../../config/schema";
import {
  createPermanentMuteDeliveryPreference,
  createThrottleDeliveryPreference,
  createTimedMuteDeliveryPreference,
  getChatDeliveryPreference,
  setChatDeliveryPreference,
  THROTTLE_INTERVAL_MINUTES,
  TIMED_MUTE_DURATION_MINUTES,
} from "../../config/schema";
import { saveConfig } from "../../config/store";
import type { PendingMutePickerOption, PendingThrottlePickerOption } from "../../session/manager";
import type { RouterContext } from "../command-router";

const THROTTLE_PICKER_OPTIONS: Array<{ label: string; option: PendingThrottlePickerOption }> = [
  { label: "1 minute", option: { kind: "preset", value: 1 } },
  { label: "5 minutes", option: { kind: "preset", value: 5 } },
  { label: "15 minutes", option: { kind: "preset", value: 15 } },
  { label: "30 minutes", option: { kind: "preset", value: 30 } },
  { label: "Turn off", option: { kind: "off" } },
];

const MUTE_PICKER_OPTIONS: Array<{ label: string; option: PendingMutePickerOption }> = [
  { label: "15 minutes", option: { kind: "timed", value: 15 } },
  { label: "30 minutes", option: { kind: "timed", value: 30 } },
  { label: "1 hour", option: { kind: "timed", value: 60 } },
  { label: "Mute until I unmute", option: { kind: "permanent" } },
];

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "");
}

function formatMinutes(minutes: number): string {
  if (minutes === 60) return "1 hour";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function isThrottlePreference(delivery: ChatDeliveryPreference): delivery is ThrottleDeliveryPreference {
  return delivery.mode === "throttle";
}

function isTimedMutePreference(delivery: ChatDeliveryPreference): delivery is TimedMuteDeliveryPreference {
  return delivery.mode === "mute" && delivery.kind === "timed";
}

function isPermanentMutePreference(delivery: ChatDeliveryPreference): delivery is PermanentMuteDeliveryPreference {
  return delivery.mode === "mute" && delivery.kind === "permanent";
}

function formatMuteStatus(delivery: TimedMuteDeliveryPreference | PermanentMuteDeliveryPreference): string {
  if (delivery.kind === "permanent") {
    return "muted until you use /unmute";
  }
  const remainingMs = Math.max(0, Date.parse(delivery.mutedUntil) - Date.now());
  const roundedMinutes = Math.max(1, Math.round(remainingMs / 60_000));
  return `muted for ${formatMinutes(roundedMinutes)}`;
}

export function buildThrottlePickerPrompt(): {
  title: string;
  options: PendingThrottlePickerOption[];
  optionLabels: string[];
} {
  return {
    title: "Choose a throttle preset",
    options: THROTTLE_PICKER_OPTIONS.map((choice) => choice.option),
    optionLabels: THROTTLE_PICKER_OPTIONS.map((choice) => choice.label),
  };
}

export function buildMutePickerPrompt(): {
  title: string;
  options: PendingMutePickerOption[];
  optionLabels: string[];
} {
  return {
    title: "Choose a mute preset",
    options: MUTE_PICKER_OPTIONS.map((choice) => choice.option),
    optionLabels: MUTE_PICKER_OPTIONS.map((choice) => choice.label),
  };
}

function buildThrottleUsageText(): string {
  return [
    "Usage:",
    "/throttle 1m",
    "/throttle 5m",
    "/throttle 15m",
    "/throttle 30m",
    "/throttle off",
  ].join("\n");
}

function buildMuteUsageText(): string {
  return [
    "Usage:",
    "/mute 15m",
    "/mute 30m",
    "/mute 1h",
    "/mute forever",
    "/unmute",
  ].join("\n");
}

export function buildThrottleSummaryMessage(
  chatId: string,
  config: RouterContext["config"],
  fmt: Formatter
): string {
  const delivery = getChatDeliveryPreference(config, chatId);
  if (isThrottlePreference(delivery)) {
    return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Throttle"))}\n${fmt.escape(`Active every ${formatMinutes(delivery.intervalMinutes)}. Bridge output is buffered between summaries. Use /throttle off to return to immediate delivery.`)}`;
  }
  if (delivery.mode === "mute") {
    return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Throttle"))}\n${fmt.escape(`Unavailable while this chat is ${formatMuteStatus(delivery)}. Use /unmute before switching back to throttled delivery.`)}`;
  }
  return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Throttle"))}\n${fmt.escape("Off. Bridge output is delivered immediately.")}`;
}

export function buildMuteSummaryMessage(
  chatId: string,
  config: RouterContext["config"],
  fmt: Formatter
): string {
  const delivery = getChatDeliveryPreference(config, chatId);
  if (delivery.mode === "mute") {
    return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Mute"))}\n${fmt.escape(`Active — ${formatMuteStatus(delivery)}. Bridge output stays silent until the mute ends or you use /unmute.`)}`;
  }
  if (isThrottlePreference(delivery)) {
    return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Mute"))}\n${fmt.escape(`Off. Throttle is still active every ${formatMinutes(delivery.intervalMinutes)}.`)}`;
  }
  return `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape("Mute"))}\n${fmt.escape("Off. Bridge output is delivered immediately.")}`;
}

export function parseThrottleModeArg(modeArg: string): ThrottleIntervalMinutes | "off" | null {
  const token = normalizeToken(modeArg);
  if (token === "off" || token === "disable" || token === "disabled" || token === "immediate") {
    return "off";
  }
  if (token === "1m") return 1;
  if (token === "5m") return 5;
  if (token === "15m") return 15;
  if (token === "30m") return 30;
  return null;
}

export function parseMuteModeArg(modeArg: string): TimedMuteDurationMinutes | "permanent" | null {
  const token = normalizeToken(modeArg);
  if (token === "15m") return 15;
  if (token === "30m") return 30;
  if (token === "1h") return 60;
  if (token === "forever" || token === "permanent") return "permanent";
  return null;
}

function describeThrottleNoop(delivery: ChatDeliveryPreference): string {
  if (isThrottlePreference(delivery)) {
    return `Throttle is already active every ${formatMinutes(delivery.intervalMinutes)}.`;
  }
  if (delivery.mode === "mute") {
    return `This chat is ${formatMuteStatus(delivery)}. Use /unmute before changing throttle.`;
  }
  return "Throttle is already off.";
}

function describeMuteNoop(delivery: ChatDeliveryPreference, requested: TimedMuteDurationMinutes | "permanent"): string {
  if (isTimedMutePreference(delivery) && requested !== "permanent") {
    const requestedUntil = createTimedMuteDeliveryPreference(requested, delivery.activatedAt).mutedUntil;
    if (delivery.mutedUntil === requestedUntil) {
      return `This chat is already muted for ${formatMinutes(requested)}.`;
    }
  }
  if (isPermanentMutePreference(delivery) && requested === "permanent") {
    return "This chat is already muted until you use /unmute.";
  }
  return `This chat is currently ${delivery.mode === "mute" ? formatMuteStatus(delivery) : "not muted"}.`;
}

async function applyDeliveryChange(
  msg: InboundMessage,
  ctx: RouterContext,
  nextDelivery: ChatDeliveryPreference
): Promise<boolean> {
  const changed = setChatDeliveryPreference(ctx.config, msg.chatId, nextDelivery);
  if (!changed) return false;
  await saveConfig(ctx.config);
  if (nextDelivery.mode !== "immediate") {
    ctx.channel.setTyping(msg.chatId, false);
  }
  return true;
}

export async function handleThrottleCommand(
  msg: InboundMessage,
  modeArg: string | undefined,
  ctx: RouterContext
): Promise<void> {
  const { fmt } = ctx.channel;
  const current = getChatDeliveryPreference(ctx.config, msg.chatId);

  if (!modeArg) {
    await ctx.channel.send(msg.chatId, buildThrottleSummaryMessage(msg.chatId, ctx.config, fmt));
    if (ctx.channel.sendPoll) {
      const picker = buildThrottlePickerPrompt();
      const sent = await ctx.channel.sendPoll(msg.chatId, picker.title, picker.optionLabels, false);
      ctx.sessionManager.registerThrottlePicker({
        pollId: sent.pollId,
        messageId: sent.messageId,
        chatId: msg.chatId,
        ownerUserId: msg.userId,
        options: picker.options,
      });
      return;
    }
    await ctx.channel.send(msg.chatId, fmt.escape(buildThrottleUsageText()));
    return;
  }

  const parsed = parseThrottleModeArg(modeArg);
  if (parsed === null) {
    await ctx.channel.send(msg.chatId, `${fmt.escape(buildThrottleUsageText())}\n\n${buildThrottleSummaryMessage(msg.chatId, ctx.config, fmt)}`);
    return;
  }

  if (parsed === "off") {
    if (current.mode === "immediate") {
      await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape(describeThrottleNoop(current))}`);
      return;
    }
    await applyDeliveryChange(msg, ctx, { mode: "immediate" });
    await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape("Throttle is off. Bridge output is now immediate for this chat.")}`);
    return;
  }

  if (isThrottlePreference(current) && current.intervalMinutes === parsed) {
    await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape(describeThrottleNoop(current))}`);
    return;
  }

  await applyDeliveryChange(msg, ctx, createThrottleDeliveryPreference(parsed));
  await ctx.channel.send(
    msg.chatId,
    `${fmt.escape("⛳️")} ${fmt.escape(`Throttle is active every ${formatMinutes(parsed)}. Bridge output will be summarized on that cadence until you use /throttle off.`)}`
  );
}

export async function handleMuteCommand(
  msg: InboundMessage,
  modeArg: string | undefined,
  ctx: RouterContext
): Promise<void> {
  const { fmt } = ctx.channel;
  const current = getChatDeliveryPreference(ctx.config, msg.chatId);

  if (!modeArg) {
    await ctx.channel.send(msg.chatId, buildMuteSummaryMessage(msg.chatId, ctx.config, fmt));
    if (ctx.channel.sendPoll) {
      const picker = buildMutePickerPrompt();
      const sent = await ctx.channel.sendPoll(msg.chatId, picker.title, picker.optionLabels, false);
      ctx.sessionManager.registerMutePicker({
        pollId: sent.pollId,
        messageId: sent.messageId,
        chatId: msg.chatId,
        ownerUserId: msg.userId,
        options: picker.options,
      });
      return;
    }
    await ctx.channel.send(msg.chatId, fmt.escape(buildMuteUsageText()));
    return;
  }

  const parsed = parseMuteModeArg(modeArg);
  if (parsed === null) {
    await ctx.channel.send(msg.chatId, `${fmt.escape(buildMuteUsageText())}\n\n${buildMuteSummaryMessage(msg.chatId, ctx.config, fmt)}`);
    return;
  }

  if (current.mode === "mute") {
    if (
      (parsed === "permanent" && isPermanentMutePreference(current))
      || (parsed !== "permanent" && isTimedMutePreference(current) && current.mutedUntil === createTimedMuteDeliveryPreference(parsed, current.activatedAt).mutedUntil)
    ) {
      await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape(describeMuteNoop(current, parsed))}`);
      return;
    }
  }

  const nextDelivery = parsed === "permanent"
    ? createPermanentMuteDeliveryPreference()
    : createTimedMuteDeliveryPreference(parsed);
  await applyDeliveryChange(msg, ctx, nextDelivery);
  await ctx.channel.send(
    msg.chatId,
    `${fmt.escape("⛳️")} ${fmt.escape(`Bridge output is now ${parsed === "permanent" ? "muted until you use /unmute" : `muted for ${formatMinutes(parsed)}`}.`)}`
  );
}

export async function handleUnmuteCommand(
  msg: InboundMessage,
  ctx: RouterContext
): Promise<void> {
  const { fmt } = ctx.channel;
  const current = getChatDeliveryPreference(ctx.config, msg.chatId);
  if (current.mode !== "mute") {
    const suffix = isThrottlePreference(current)
      ? ` Throttle remains active every ${formatMinutes(current.intervalMinutes)}.`
      : "";
    await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape(`This chat is not muted.${suffix}`)}`);
    return;
  }

  await applyDeliveryChange(msg, ctx, { mode: "immediate" });
  await ctx.channel.send(msg.chatId, `${fmt.escape("⛳️")} ${fmt.escape("Bridge output is now immediate for this chat.")}`);
}

export function isThrottleInterval(value: unknown): value is ThrottleIntervalMinutes {
  return THROTTLE_INTERVAL_MINUTES.includes(value as ThrottleIntervalMinutes);
}

export function isTimedMuteDuration(value: unknown): value is TimedMuteDurationMinutes {
  return TIMED_MUTE_DURATION_MINUTES.includes(value as TimedMuteDurationMinutes);
}
