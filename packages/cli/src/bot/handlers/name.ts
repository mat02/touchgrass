import { updateSessionManifestName } from "../../session/manifest";
import type { InboundMessage } from "../../channel/types";
import type { RemoteSession } from "../../session/manager";
import type { RouterContext } from "../command-router";

function resolveTargetRemote(msg: InboundMessage, ctx: RouterContext): RemoteSession | null {
  const attached = ctx.sessionManager.getAttachedRemote(msg.chatId);
  if (attached && attached.ownerUserId === msg.userId) return attached;
  if (attached && attached.ownerUserId !== msg.userId) return null;

  const remotes = ctx.sessionManager.listRemotesForUser(msg.userId);
  if (remotes.length === 1 && !msg.isGroup) return remotes[0];
  return null;
}

function normalizeNameArg(rawArg: string | undefined): { kind: "show" } | { kind: "clear" } | { kind: "set"; name: string } {
  const trimmed = rawArg?.trim();
  if (!trimmed) return { kind: "show" };

  const unwrapped = trimmed.replace(/^['"`]+|['"`]+$/g, "").trim();
  if (!unwrapped) return { kind: "show" };
  if (unwrapped === "clear" || unwrapped === "-") return { kind: "clear" };
  return { kind: "set", name: unwrapped };
}

export async function handleNameCommand(
  msg: InboundMessage,
  rawArg: string | undefined,
  ctx: RouterContext
): Promise<void> {
  const { fmt } = ctx.channel;
  const remote = resolveTargetRemote(msg, ctx);

  if (!remote) {
    await ctx.channel.send(
      msg.chatId,
      `No connected touchgrass session for this chat. Use ${fmt.code("/change_session")} or ${fmt.code("/session")} first.`
    );
    return;
  }

  const parsed = normalizeNameArg(rawArg);
  if (parsed.kind === "show") {
    const lines = [
      `${fmt.escape("touchgrass session ID:")} ${fmt.code(fmt.escape(remote.id))}`,
      remote.name
        ? `${fmt.escape("Current name:")} ${fmt.code(fmt.escape(remote.name))}`
        : `${fmt.escape("Current name:")} ${fmt.escape("none")}`,
      `${fmt.escape("Set with")} ${fmt.code("/name <new name>")}`,
      `${fmt.escape("Clear with")} ${fmt.code("/name clear")}`,
    ];
    await ctx.channel.send(msg.chatId, lines.join("\n"));
    return;
  }

  const nextName = parsed.kind === "clear" ? undefined : parsed.name;
  ctx.sessionManager.setRemoteName(remote.id, nextName);
  await updateSessionManifestName(remote.id, nextName).catch(() => {});

  if (!nextName) {
    await ctx.channel.send(
      msg.chatId,
      `Cleared custom name for session ${fmt.code(fmt.escape(remote.id))}.`
    );
    return;
  }

  await ctx.channel.send(
    msg.chatId,
    `Session ${fmt.code(fmt.escape(remote.id))} is now named ${fmt.code(fmt.escape(nextName))}.`
  );
}
