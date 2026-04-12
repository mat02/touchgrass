import { runPeek } from "./peek";
import { runWrite } from "./send";

const UNAVAILABLE_MESSAGE =
  "Office visual commands are unavailable in this checkout. Supported office subcommands: peek, chat.";

export async function runOfficeCommand(subcommand: string, args: string[]): Promise<void> {
  if (subcommand === "peek") {
    process.argv = [process.argv[0] || "bun", "touchgrass", "peek", ...args];
    await runPeek();
    return;
  }

  if (subcommand === "chat") {
    process.argv = [process.argv[0] || "bun", "touchgrass", "write", ...args];
    await runWrite();
    return;
  }

  console.error(`${UNAVAILABLE_MESSAGE} Requested: office ${subcommand}`);
  process.exit(1);
}

export async function runOffice(_officeName: string): Promise<void> {
  console.error(UNAVAILABLE_MESSAGE);
  process.exit(1);
}
