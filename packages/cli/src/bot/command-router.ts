import type { Channel, ChannelChatId, ChannelUserId, InboundMessage } from "../channel/types";
import { isTopic, getParentChatId } from "../channel/types";
import type { TgConfig } from "../config/schema";
import type { SessionManager } from "../session/manager";
import { isUserPaired } from "../security/allowlist";
import {
  addLinkedGroup,
  getChatMuted,
  isLinkedGroup,
  removeLinkedGroup,
  updateLinkedGroupTitle,
} from "../config/schema";
import { saveConfig } from "../config/store";
import { handlePair } from "./handlers/pair";
import { handleHelp } from "./handlers/help";
import { handleSessionMgmt } from "./handlers/session-mgmt";
import { handleStdinInput } from "./handlers/stdin-input";
import { handleInlineFileSearch } from "./handlers/files";
import { handleSessionCommand } from "./handlers/session";
import { handleNameCommand } from "./handlers/name";
import { handleOutputModeCommand } from "./handlers/output-mode";
import type { BackgroundJobSessionSummary } from "./handlers/background-jobs";
import { handleSkillsCommand } from "./handlers/skills";
import { handleMuteCommand } from "./handlers/mute";
import { handleStartRemoteControl, handleStopRemoteControl } from "./handlers/remote-control";
import { logger } from "../daemon/logger";
import { notifyApp } from "../daemon/notify-app";

export interface RouterContext {
  config: TgConfig;
  channelName?: string;
  sessionManager: SessionManager;
  channel: Channel;
  listBackgroundJobs?: (
    userId: ChannelUserId,
    chatId: ChannelChatId
  ) => BackgroundJobSessionSummary[] | Promise<BackgroundJobSessionSummary[]>;
}

function syncCommandMenuAsync(
  ctx: RouterContext,
  args: {
    userId: ChannelUserId;
    chatId: ChannelChatId;
    isPaired: boolean;
    isGroup: boolean;
    isLinkedGroup: boolean;
    hasActiveSession: boolean;
    isMuted: boolean;
  }
): void {
  const sync = ctx.channel.syncCommandMenu;
  if (!sync) return;
  void sync.call(ctx.channel, args).catch(async (error: unknown) => {
    await logger.debug("Command menu sync failed", {
      chatId: args.chatId,
      userId: args.userId,
      error: (error as Error)?.message ?? String(error),
    });
  });
}

export async function routeMessage(
  msg: InboundMessage,
  ctx: RouterContext
): Promise<void> {
  let text = msg.text?.trim();
  if (!text) return;

  // Telegram group commands can arrive as /command@BotName.
  // Normalize to /command so command matching works consistently.
  if (ctx.channel.type === "telegram") {
    text = text.replace(/^\/([a-z0-9_]+)@[^\s]+(?=\s|$)/i, "/$1");
  }

  // Channel-agnostic command aliases for platforms where slash commands are not practical.
  // Accept both "touchgrass <cmd>" and "tg <cmd>" for backwards compatibility.
  const cmdPrefix = text.startsWith("touchgrass ") ? "touchgrass" : text.startsWith("tg ") ? "tg" : null;
  if (cmdPrefix) {
    const rest = text.slice(cmdPrefix.length);
    if (rest === " session") text = "/session";
    else if (rest === " name" || rest.startsWith(" name ")) text = `/name${rest.slice(" name".length)}`;
    else if (rest === " change_session" || rest === " change-session") text = "/change_session";
    else if (rest === " output_mode" || rest.startsWith(" output_mode ")) text = `/output_mode${rest.slice(" output_mode".length)}`;
    else if (rest === " output-mode" || rest.startsWith(" output-mode ")) text = `/output_mode${rest.slice(" output-mode".length)}`;
    else if (rest === " throttle" || rest.startsWith(" throttle ")) text = `/throttle${rest.slice(" throttle".length)}`;
    else if (rest === " mute") text = "/mute";
    else if (rest === " unmute") text = "/unmute";
    else if (rest === " skills") text = "/skills";
    else if (rest === " link" || rest.startsWith(" link ")) text = `/link${rest.slice(" link".length)}`;
    else if (rest === " unlink") text = "/unlink";
    else if (rest === " rc") text = "/start_remote_control";
    else if (rest === " rc stop") text = "/stop_remote_control";
    else if (rest === " pair" || rest.startsWith(" pair ")) text = `/pair${rest.slice(" pair".length)}`;
  }

  const userId = msg.userId;
  const chatId = msg.chatId;
  const channelName = ctx.channelName;
  const { fmt } = ctx.channel;
  const isGroup = !!msg.isGroup;
  const linked = isLinkedGroup(ctx.config, chatId, channelName);
  const paired = isUserPaired(ctx.config, userId);
  const hasActiveSession = !!ctx.sessionManager.getAttachedRemote(chatId);
  const isMuted = getChatMuted(ctx.config, chatId);

  syncCommandMenuAsync(ctx, {
    userId,
    chatId,
    isPaired: paired,
    isGroup,
    isLinkedGroup: linked,
    hasActiveSession,
    isMuted,
  });

  await logger.debug("Received message", {
    userId,
    chatId,
    isCommand: text.startsWith("/"),
    textLen: text.length,
  });

  // /pair is always available (for unpaired users)
  if (text.startsWith("/pair")) {
    await handlePair({ ...msg, text }, ctx);
    syncCommandMenuAsync(ctx, {
      userId,
      chatId,
      isPaired: isUserPaired(ctx.config, userId),
      isGroup,
      isLinkedGroup: isLinkedGroup(ctx.config, chatId, channelName),
      hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
      isMuted: getChatMuted(ctx.config, chatId),
    });
    return;
  }

  // /start in DM keeps Telegram onboarding/help behavior.
  if (!isGroup && (text === "/start" || text.startsWith("/start "))) {
    await handleHelp({ ...msg, text }, ctx);
    return;
  }

  if (text === "/help") {
    await handleHelp({ ...msg, text }, ctx);
    return;
  }

  // Everything else requires pairing
  if (!paired) {
    await ctx.channel.send(
      chatId,
      `You are not paired. Use /pair ${fmt.escape("<code>")} to pair.`
    );
    return;
  }

  if (text === "/sessions") {
    await ctx.channel.send(chatId, `The ${fmt.code("/sessions")} command was removed. Use ${fmt.code("touchgrass ls")} in your terminal.`);
    return;
  }

  if (text === "/mute" || text === "/unmute") {
    await handleMuteCommand({ ...msg, text }, text === "/mute", ctx);
    syncCommandMenuAsync(ctx, {
      userId,
      chatId,
      isPaired: paired,
      isGroup,
      isLinkedGroup: linked,
      hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
      isMuted: getChatMuted(ctx.config, chatId),
    });
    return;
  }

  if (text.startsWith("/mute ") || text.startsWith("/unmute ")) {
    await ctx.channel.send(chatId, `Use ${fmt.code("/mute")} or ${fmt.code("/unmute")} with no arguments.`);
    return;
  }

  if (text === "/stop" || text === "/kill" || text === "/new" || text === "/start" || text.startsWith("/start ") || text.startsWith("/new ")) {
    await ctx.channel.send(
      chatId,
      `${fmt.escape("⛳️ Chat-side session start/stop was removed. Start sessions from your terminal with")} ${fmt.code("touchgrass claude")}, ${fmt.code("touchgrass codex")}, ${fmt.code("touchgrass pi")}, ${fmt.code("touchgrass omp")}, ${fmt.code("touchgrass kimi")}, ${fmt.code("touchgrass gemini")} ${fmt.escape("and use")} ${fmt.code("touchgrass stop <id>")} ${fmt.escape("or")} ${fmt.code("touchgrass kill <id>")} ${fmt.escape("from terminal when needed.")}`
    );
    return;
  }

  // /start_remote_control auto-links unlinked groups
  if ((text === "/start_remote_control" || text === "/start-remote-control") && isGroup && !linked) {
    if (isTopic(chatId)) {
      const parentChat = getParentChatId(chatId);
      if (addLinkedGroup(ctx.config, parentChat, msg.chatTitle, channelName)) {
        await saveConfig(ctx.config);
      }
      const topicTitle = msg.topicTitle || "Topic";
      addLinkedGroup(ctx.config, chatId, topicTitle, channelName);
    } else {
      addLinkedGroup(ctx.config, chatId, msg.chatTitle, channelName);
    }
    await saveConfig(ctx.config);
    notifyApp({ type: "channel-linked", title: msg.chatTitle || "Group", chatId });
  }

  if (
    isGroup &&
    text !== "/link" &&
    !text.startsWith("/link ") &&
    text !== "/unlink" &&
    text !== "/start_remote_control" &&
    text !== "/start-remote-control" &&
    text !== "/change_session" &&
    text !== "/change-session" &&
    text !== "/files" &&
    !text.startsWith("/files ") &&
    text !== "/thinking" &&
    !text.startsWith("/thinking ") &&
    text !== "/background-jobs" &&
    text !== "/background_jobs" &&
    !linked
  ) {
    await ctx.channel.send(chatId, `This group is not linked yet. Run ${fmt.code("/link")} or ${fmt.code("/start_remote_control")} first.`);
    return;
  }

  // Auto-update group title if it changed
  if (isGroup && msg.chatTitle && !isTopic(chatId)) {
    if (updateLinkedGroupTitle(ctx.config, chatId, msg.chatTitle, channelName)) {
      await saveConfig(ctx.config);
    }
  }
  // Auto-update topic title if detected from Telegram
  if (isGroup && msg.topicTitle && isTopic(chatId)) {
    if (updateLinkedGroupTitle(ctx.config, chatId, msg.topicTitle, channelName)) {
      await saveConfig(ctx.config);
    }
  }

  if (text === "/files" || text.startsWith("/files ")) {
    await ctx.channel.send(
      chatId,
      `The ${fmt.code("/files")} command was removed. Use ${fmt.code("@?<query>")} to search files inline.`
    );
    return;
  }

  if (text === "/thinking" || text.startsWith("/thinking ")) {
    await ctx.channel.send(
      chatId,
      `The ${fmt.code("/thinking")} command was removed. Use ${fmt.code("/output_mode thinking")} instead.`
    );
    return;
  }

  if (text === "/background-jobs" || text === "/background_jobs") {
    await ctx.channel.send(chatId, `The ${fmt.code("/background_jobs")} command was removed.`);
    return;
  }

  // /start_remote_control or /change_session — pick a running session to connect to this chat
  if (text === "/start_remote_control" || text === "/start-remote-control" || text === "/change_session" || text === "/change-session") {
    await handleStartRemoteControl({ ...msg, text }, ctx);
    return;
  }

  // /stop_remote_control — disconnect session from this chat
  if (text === "/stop_remote_control" || text === "/stop-remote-control") {
    await handleStopRemoteControl({ ...msg, text }, ctx);
    syncCommandMenuAsync(ctx, {
      userId,
      chatId,
      isPaired: paired,
      isGroup,
      isLinkedGroup: linked,
      hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
      isMuted: getChatMuted(ctx.config, chatId),
    });
    return;
  }

  // /session — show current connected session + resume commands
  if (text === "/session") {
    await handleSessionCommand({ ...msg, text }, ctx);
    return;
  }

  // /name [value] — set or clear the current session name
  if (text === "/name" || text.startsWith("/name ")) {
    const nameArg = text.slice("/name".length).trim() || undefined;
    await handleNameCommand({ ...msg, text }, nameArg, ctx);
    return;
  }

  // /skills — list available agent skills
  if (text === "/skills") {
    await handleSkillsCommand({ ...msg, text }, ctx);
    return;
  }

  // /output_mode or /throttle [preset|setting value] — configure Telegram output delivery
  if (
    text === "/output_mode"
    || text === "/output-mode"
    || text.startsWith("/output_mode ")
    || text.startsWith("/output-mode ")
    || text === "/throttle"
    || text.startsWith("/throttle ")
  ) {
    const modeArg = text.startsWith("/throttle")
      ? text.slice("/throttle".length).trim() || undefined
      : text.replace(/^\/output(?:_|-)mode/i, "").trim() || undefined;
    await handleOutputModeCommand({ ...msg, text }, modeArg, ctx);
    return;
  }

  // @?query → file picker, @?query - prompt → resolve top path and send
  if (text.startsWith("@?")) {
    const handled = await handleInlineFileSearch({ ...msg, text }, text, ctx);
    if (handled) return;
  }

  // /link — register this group or topic with the bot
  if (text === "/link" || text.startsWith("/link ")) {
    if (!isGroup) {
      await ctx.channel.send(chatId, "Use /link in a group or topic to register it with the bot.");
      return;
    }
    const linkArg = text.slice(5).trim(); // optional name for topics

    if (isTopic(chatId)) {
      // Auto-link parent group if not already linked
      const parentChat = getParentChatId(chatId);
      if (addLinkedGroup(ctx.config, parentChat, msg.chatTitle, channelName)) {
        await saveConfig(ctx.config);
      }
      // Require a name for topics (auto-detected or user-provided)
      const topicTitle = linkArg || msg.topicTitle;
      if (!topicTitle) {
        await ctx.channel.send(chatId, `Please provide a name: ${fmt.code("/link MyTopic")}`);
        return;
      }
      const added = addLinkedGroup(ctx.config, chatId, topicTitle, channelName);
      if (added) {
        await saveConfig(ctx.config);
        notifyApp({ type: "channel-linked", title: topicTitle, chatId });
        await ctx.channel.send(chatId, `Topic ${fmt.bold(fmt.escape(topicTitle))} linked. You can now connect a ⛳️ Touchgrass session to it.`);
      } else {
        await ctx.channel.send(chatId, `This topic is already linked.`);
      }
      syncCommandMenuAsync(ctx, {
        userId,
        chatId,
        isPaired: true,
        isGroup,
        isLinkedGroup: isLinkedGroup(ctx.config, chatId, channelName),
        hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
        isMuted: getChatMuted(ctx.config, chatId),
      });
    } else {
      const added = addLinkedGroup(ctx.config, chatId, msg.chatTitle, channelName);
      if (added) {
        await saveConfig(ctx.config);
        notifyApp({ type: "channel-linked", title: msg.chatTitle || "Group", chatId });
        await ctx.channel.send(chatId, `Group added as a channel to ⛳️ Touchgrass. You can now connect a session to it.`);
      } else {
        await ctx.channel.send(chatId, `This group is already linked.`);
      }
      syncCommandMenuAsync(ctx, {
        userId,
        chatId,
        isPaired: true,
        isGroup,
        isLinkedGroup: isLinkedGroup(ctx.config, chatId, channelName),
        hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
        isMuted: getChatMuted(ctx.config, chatId),
      });
    }
    return;
  }

  // /unlink — unregister this group/topic from the bot
  if (text === "/unlink") {
    if (!isGroup) {
      await ctx.channel.send(chatId, "Use /unlink in a group or topic to unregister it.");
      return;
    }
    if (removeLinkedGroup(ctx.config, chatId, channelName)) {
      await saveConfig(ctx.config);
      notifyApp({ type: "channel-unlinked", chatId });
      await ctx.channel.send(chatId, isTopic(chatId) ? "Topic unlinked." : "Group unlinked.");
    } else {
      await ctx.channel.send(chatId, "This chat is not linked.");
    }
    syncCommandMenuAsync(ctx, {
      userId,
      chatId,
      isPaired: true,
      isGroup,
      isLinkedGroup: isLinkedGroup(ctx.config, chatId, channelName),
      hasActiveSession: !!ctx.sessionManager.getAttachedRemote(chatId),
      isMuted: getChatMuted(ctx.config, chatId),
    });
    return;
  }

  // touchgrass <command> / tg <command> - session management
  const mgmtPrefix = text.startsWith("touchgrass ") ? "touchgrass " : text.startsWith("tg ") ? "tg " : null;
  if (mgmtPrefix) {
    const args = text.slice(mgmtPrefix.length).trim();

    if (args === "files" || args.startsWith("files ")) {
      await ctx.channel.send(
        chatId,
        `The ${fmt.code("touchgrass files")} command was removed. Use ${fmt.code("@?<query>")} to search files inline.`
      );
      return;
    }

    if (args === "thinking" || args.startsWith("thinking ")) {
      await ctx.channel.send(
        chatId,
        `The ${fmt.code("touchgrass thinking")} command was removed. Use ${fmt.code("touchgrass output_mode thinking")} instead.`
      );
      return;
    }

    if (args === "background_jobs" || args === "background-jobs" || args.startsWith("background_jobs ") || args.startsWith("background-jobs ")) {
      await ctx.channel.send(chatId, `The ${fmt.code("touchgrass background-jobs")} command was removed.`);
      return;
    }

    // Session management commands
    if (["ls", "attach", "detach", "stop", "kill", "restart", "session"].some((cmd) => args.startsWith(cmd))) {
      await handleSessionMgmt(msg, args, ctx);
      return;
    }

    await ctx.channel.send(
      chatId,
      `Unknown command. Use ${fmt.code("touchgrass session")}, ${fmt.code("touchgrass name <value>")}, ${fmt.code("touchgrass resume")}, ${fmt.code("touchgrass output_mode")}, ${fmt.code("touchgrass output_mode simple")}, ${fmt.code("touchgrass output_mode tool_calls off")}, ${fmt.code("touchgrass attach <id>")}, ${fmt.code("touchgrass detach")}, ${fmt.code("touchgrass stop <id>")}, ${fmt.code("touchgrass kill <id>")}, or ${fmt.code("touchgrass restart [session_id]")}. Start sessions from your terminal with ${fmt.code("touchgrass claude")}, ${fmt.code("touchgrass codex")}, ${fmt.code("touchgrass pi")}, ${fmt.code("touchgrass omp")}, ${fmt.code("touchgrass kimi")}, or ${fmt.code("touchgrass gemini")}.`
    );
    return;
  }

  // /message <text> → send to attached session (regular or remote)
  if (text.startsWith("/message ")) {
    const inputText = text.slice(9);
    if (inputText) {
      const syntheticMsg: InboundMessage = { ...msg, text: inputText };
      await handleStdinInput(syntheticMsg, ctx);
    }
    return;
  }

  // Non-command text → stdin of attached session
  await handleStdinInput(msg, ctx);
}
