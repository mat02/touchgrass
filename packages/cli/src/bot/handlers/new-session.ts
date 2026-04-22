import type { InboundMessage } from "../../channel/types";
import type { RouterContext } from "../command-router";

export async function handleNewSessionCommand(
  msg: InboundMessage,
  ctx: RouterContext
): Promise<void> {
  const attached = ctx.sessionManager.getAttachedRemote(msg.chatId);
  const { fmt } = ctx.channel;

  if (!attached || attached.ownerUserId !== msg.userId) {
    await ctx.channel.send(
      msg.chatId,
      `No connected touchgrass session for this chat. Use ${fmt.code("/change_session")} or ${fmt.code("/session")} first.`
    );
    return;
  }

  const tool = attached.command.split(/\s+/, 1)[0];
  if (tool !== "omp") {
    await ctx.channel.send(
      msg.chatId,
      `${fmt.code("/new")} is only supported for attached OMP sessions.`
    );
    return;
  }

  if (!ctx.sessionManager.requestRemoteOmpNew(attached.id)) {
    await ctx.channel.send(msg.chatId, "Session is no longer active.");
    return;
  }

  await ctx.channel.send(
    msg.chatId,
    `Requested ${fmt.code("/new")} for the attached OMP session. If OMP rolls over to a new session, this chat will ask you which touchgrass session to attach.`
  );
}
