import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __cliRunTestUtils } from "../cli/run";

describe("background job parser", () => {
  it("parses Gemini assistant JSON into ordered conversation events", () => {
    __cliRunTestUtils.resetParserState();

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      role: "assistant",
      content: "  Gemini says hi  ",
    });

    expect(parsed.assistantText).toBe("Gemini says hi");
    expect(parsed.conversationEvents).toEqual([
      { kind: "assistant", text: "Gemini says hi" },
    ]);
  });


  it("extracts running background jobs from Claude tool results", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "Bash",
            input: { command: "npm run dev", run_in_background: true },
          },
        ],
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            is_error: false,
            content:
              "Command running in background with ID: bg_abc123. Output is being written to: /tmp/bg_abc123.output\nDetected URLs:\n- http://localhost:5173/",
          },
        ],
      },
      toolUseResult: { backgroundTaskId: "bg_abc123" },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "bg_abc123",
        status: "running",
        command: "npm run dev",
        outputFile: "/tmp/bg_abc123.output",
        urls: ["http://localhost:5173/"],
      },
    ]);
  });

  it("extracts stop events from queue task notifications", () => {
    __cliRunTestUtils.resetParserState();

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "queue-operation",
      operation: "enqueue",
      content:
        "<task-notification>\n<task-id>bg_stop_me</task-id>\n<output-file>/tmp/bg_stop_me.output</output-file>\n<status>killed</status>\n<summary>Background command stopped</summary>\n</task-notification>",
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "bg_stop_me",
        status: "killed",
        outputFile: "/tmp/bg_stop_me.output",
        summary: "Background command stopped",
      },
    ]);
  });

  it("extracts stop events from TaskStop tool results", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_stop1",
            name: "TaskStop",
            input: { task_id: "bg_live_1" },
          },
        ],
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_stop1",
            content:
              "{\"message\":\"Successfully stopped task: bg_live_1 (node server.js --port 9001)\",\"task_id\":\"bg_live_1\",\"command\":\"node server.js --port 9001\"}",
          },
        ],
      },
      toolUseResult: {
        task_id: "bg_live_1",
        message: "Successfully stopped task: bg_live_1 (node server.js --port 9001)",
        command: "node server.js --port 9001",
      },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "bg_live_1",
        status: "killed",
        command: "node server.js --port 9001",
        urls: ["http://localhost:9001"],
      },
    ]);
  });

  it("infers a localhost URL from the background command when tool output has no URL", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_bg1",
            name: "Bash",
            input: { command: "node server.js --port 8788", run_in_background: true },
          },
        ],
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_bg1",
            type: "tool_result",
            content: "Command running in background with ID: bg_8788. Output is being written to: /tmp/bg_8788.output",
            is_error: false,
          },
        ],
      },
      toolUseResult: { backgroundTaskId: "bg_8788" },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "bg_8788",
        status: "running",
        command: "node server.js --port 8788",
        outputFile: "/tmp/bg_8788.output",
        urls: ["http://localhost:8788"],
      },
    ]);
  });

  it("strips trailing quotes from detected URLs", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_q1",
            name: "Bash",
            input: { command: "node server.js --port 8789", run_in_background: true },
          },
        ],
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_q1",
            type: "tool_result",
            content:
              "Command running in background with ID: bg_8789. Output is being written to: /tmp/bg_8789.output\nURL: http://localhost:8789'",
            is_error: false,
          },
        ],
      },
      toolUseResult: { backgroundTaskId: "bg_8789" },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "bg_8789",
        status: "running",
        command: "node server.js --port 8789",
        outputFile: "/tmp/bg_8789.output",
        urls: ["http://localhost:8789"],
      },
    ]);
  });

  it("extracts running Codex background terminal events", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_codex_bg",
        arguments: JSON.stringify({
          cmd: "node server.js --port 8900",
          yield_time_ms: 1000,
        }),
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_codex_bg",
        output:
          "Chunk ID: x\nWall time: 1.0\nProcess running with session ID 80802\nOriginal token count: 0\nOutput:\n",
      },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "80802",
        status: "running",
        command: "node server.js --port 8900",
        urls: ["http://localhost:8900"],
      },
    ]);
  });

  it("extracts completed Codex background terminal events from write_stdin", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_codex_bg2",
        arguments: JSON.stringify({
          cmd: "docker stop flatsome-platform-app-run",
          yield_time_ms: 10000,
        }),
      },
    });
    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_codex_bg2",
        output:
          "Chunk ID: x\nWall time: 10.0\nProcess running with session ID 1398\nOriginal token count: 0\nOutput:\n",
      },
    });
    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "write_stdin",
        call_id: "call_codex_bg3",
        arguments: JSON.stringify({
          session_id: 1398,
          chars: "",
          yield_time_ms: 1000,
        }),
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_codex_bg3",
        output:
          "Chunk ID: y\nWall time: 0.05\nProcess exited with code 0\nOriginal token count: 10\nOutput:\nflatsome-platform-app-run\n",
      },
    });

    expect(parsed.backgroundJobEvents).toEqual([
      {
        taskId: "1398",
        status: "completed",
        command: "docker stop flatsome-platform-app-run",
      },
    ]);
  });

  it("flushes buffered Kimi assistant text on step boundaries", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      timestamp: 1,
      message: { type: "TextPart", payload: { type: "text", text: "Hello " } },
    });
    __cliRunTestUtils.parseJsonlMessage({
      timestamp: 2,
      message: { type: "TextPart", payload: { type: "text", text: "from Kimi" } },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      timestamp: 3,
      message: { type: "StepInterrupted", payload: {} },
    });

    expect(parsed.assistantText).toBe("Hello from Kimi");
  });

  it("parses Kimi tool calls and forwards web_search tool result output", () => {
    __cliRunTestUtils.resetParserState();

    const callParsed = __cliRunTestUtils.parseJsonlMessage({
      timestamp: 1,
      message: {
        type: "ToolCall",
        payload: {
          type: "function",
          id: "kimi-call-1",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "touchgrass" }),
          },
        },
      },
    });
    expect(callParsed.toolCalls).toEqual([
      {
        id: "kimi-call-1",
        name: "web_search",
        input: { query: "touchgrass" },
      },
    ]);

    const resultParsed = __cliRunTestUtils.parseJsonlMessage({
      timestamp: 2,
      message: {
        type: "ToolResult",
        payload: {
          tool_call_id: "kimi-call-1",
          return_value: {
            is_error: false,
            output: "Result A\nResult B",
            message: "",
            display: [],
          },
        },
      },
    });

    expect(resultParsed.toolResults).toEqual([
      {
        toolName: "web_search",
        content: "Result A\nResult B",
        isError: false,
      },
    ]);
  });

  it("parses OMP session messages and ignores session headers", () => {
    __cliRunTestUtils.resetParserState();

    const headerParsed = __cliRunTestUtils.parseJsonlMessage({
      type: "session",
      version: 3,
      id: "1f9d2a6b9c0d1234",
      cwd: "/tmp/repo",
    });
    expect(headerParsed.assistantText).toBeNull();
    expect(headerParsed.toolCalls).toEqual([]);

    const assistantParsed = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking workspace" },
          { type: "text", text: "I found the failing file." },
          { type: "toolCall", id: "omp-call-1", name: "web_search", arguments: { query: "touchgrass omp" } },
        ],
      },
    });

    expect(assistantParsed.assistantText).toBe("I found the failing file.");
    expect(assistantParsed.thinking).toBe("checking workspace");
    expect(assistantParsed.toolCalls).toEqual([
      {
        id: "omp-call-1",
        name: "web_search",
        input: { query: "touchgrass omp" },
      },
    ]);
    expect(assistantParsed.conversationEvents).toEqual([
      { kind: "thinking", text: "checking workspace" },
      { kind: "assistant", text: "I found the failing file." },
      {
        kind: "toolCall",
        call: { id: "omp-call-1", name: "web_search", input: { query: "touchgrass omp" } },
      },
    ]);

    const resultParsed = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "omp-call-1",
        content: [{ type: "text", text: "Result A" }],
        isError: false,
      },
    });

    expect(resultParsed.toolResults).toEqual([
      {
        toolName: "web_search",
        content: "Result A",
        isError: false,
      },
    ]);
    expect(resultParsed.conversationEvents).toEqual([
      { kind: "toolResult", result: { toolName: "web_search", content: "Result A", isError: false } },
    ]);
  });

  it("preserves Claude assistant block order in conversation events", () => {
    __cliRunTestUtils.resetParserState();

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "checking logs" },
          { type: "text", text: "Found the issue." },
          { type: "tool_use", id: "toolu_456", name: "WebFetch", input: { url: "https://touchgrass.sh" } },
        ],
      },
    });

    expect(parsed.conversationEvents).toEqual([
      { kind: "thinking", text: "checking logs" },
      { kind: "assistant", text: "Found the issue." },
      {
        kind: "toolCall",
        call: { id: "toolu_456", name: "WebFetch", input: { url: "https://touchgrass.sh" } },
      },
    ]);
  });


  it("extracts OMP ask tool questions as Telegram polls", () => {
    __cliRunTestUtils.resetParserState();

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "omp-ask-1",
            name: "ask",
            arguments: {
              questions: [
                {
                  question: "Choose a path",
                  options: [{ label: "A" }, { label: "B" }],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      },
    });

    expect(parsed.questions).toEqual([
      {
        question: "Choose a path",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ]);
    expect(parsed.toolCalls).toEqual([]);
  });

  it("surfaces OMP plan mode transitions as assistant text", () => {
    __cliRunTestUtils.resetParserState();

    const entered = __cliRunTestUtils.parseJsonlMessage({
      type: "mode_change",
      mode: "plan",
      data: { planFilePath: "local://PLAN.md" },
    });
    const exited = __cliRunTestUtils.parseJsonlMessage({
      type: "mode_change",
      mode: "none",
    });

    expect(entered.assistantText).toContain("Plan mode active");
    expect(entered.assistantText).toContain("local://PLAN.md");
    expect(exited.assistantText).toContain("Plan mode exited");
  });

  it("expands OMP exit_plan_mode results into plan review text", () => {
    __cliRunTestUtils.resetParserState();

    const root = mkdtempSync(join(tmpdir(), "tg-omp-plan-review-"));
    try {
      const sessionFile = join(root, "session.jsonl");
      const localDir = join(root, "session", "local");
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, "REVIEW_PLAN.md"), "# Review Plan\n\nApprove this plan.");

      const parsed = __cliRunTestUtils.parseJsonlMessage(
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "exit_plan_mode",
            content: [{ type: "text", text: "Plan ready for approval." }],
            isError: false,
            details: {
              title: "REVIEW_PLAN",
              finalPlanFilePath: "local://REVIEW_PLAN.md",
            },
          },
        },
        sessionFile
      );

      expect(parsed.assistantText).toContain("Plan ready for approval: REVIEW_PLAN");
      expect(parsed.assistantText).toContain("# Review Plan");
      expect(parsed.assistantText).toContain("Approve this plan.");
      expect(parsed.toolResults).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers a plan artifact attachment when OMP review text is too long", () => {
    __cliRunTestUtils.resetParserState();

    const root = mkdtempSync(join(tmpdir(), "tg-omp-plan-attachment-"));
    try {
      const sessionFile = join(root, "session.jsonl");
      const localDir = join(root, "session", "local");
      mkdirSync(localDir, { recursive: true });
      const longPlan = "# Review Plan\n\n" + "A".repeat(3600);
      const artifactPath = join(localDir, "LONG_PLAN.md");
      writeFileSync(artifactPath, longPlan);

      const parsed = __cliRunTestUtils.parseJsonlMessage(
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "exit_plan_mode",
            content: [{ type: "text", text: "Plan ready for approval." }],
            isError: false,
            details: {
              title: "LONG_PLAN",
              finalPlanFilePath: "local://LONG_PLAN.md",
            },
          },
        },
        sessionFile
      );

      expect(parsed.assistantText).toBe("⛳ Plan ready for approval: LONG_PLAN");
      expect(parsed.assistantArtifact).toEqual({
        path: artifactPath,
        caption: "Plan review artifact",
      });
      expect(parsed.conversationEvents).toEqual([
        { kind: "assistant", text: "⛳ Plan ready for approval: LONG_PLAN" },
        { kind: "assistantFile", artifact: { path: artifactPath, caption: "Plan review artifact" } },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("forwards Claude Task tool results for simple-mode summarization", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_task_1",
            name: "Task",
            input: {
              description: "Check latest HelpScout tickets",
            },
          },
        ],
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_task_1",
            is_error: false,
            content: "Async agent launched successfully.\nagentId: af65706",
          },
        ],
      },
    });

    expect(parsed.toolResults).toEqual([
      {
        toolName: "Task",
        content: "Async agent launched successfully.\nagentId: af65706",
        isError: false,
      },
    ]);
  });

  it("forwards Codex sub-agent function outputs for simple-mode summarization", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_spawn_1",
        arguments: JSON.stringify({
          agent_type: "default",
          message: "You are the HelpScout agent.",
        }),
      },
    });

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_1",
        output: "{\"agent_id\":\"019c7568-cd07-7200-bb7c-8b1b6033b215\"}",
      },
    });

    expect(parsed.toolResults).toEqual([
      {
        toolName: "spawn_agent",
        content: "{\"agent_id\":\"019c7568-cd07-7200-bb7c-8b1b6033b215\"}",
        isError: false,
      },
    ]);
  });
  it("emits OMP task wait lifecycles from explicit task tool calls and results", () => {
    __cliRunTestUtils.resetParserState();

    const started = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "omp-task-1",
            name: "task",
            arguments: {
              tasks: [
                { id: "child-1", description: "Investigate failing alert" },
                { id: "child-2", title: "Prepare rollback" },
              ],
            },
          },
        ],
      },
    });

    expect(started.waitStateEvents).toEqual([
      {
        cycleSource: "omp-task",
        waitGroupKey: "omp-task:omp-task-1",
        phase: "startOrUpdate",
        items: [
          { itemKey: "child-1", title: "Investigate failing alert", status: "queued" },
          { itemKey: "child-2", title: "Prepare rollback", status: "queued" },
        ],
      },
    ]);

    const partial = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "omp-task-1",
        toolName: "task",
        isError: false,
        content: [{ type: "text", text: "partial results" }],
        details: {
          results: [
            { taskId: "child-1", description: "Investigate failing alert", exitCode: 0, output: "Found root cause" },
            { taskId: "child-2", title: "Prepare rollback", status: "running", summary: "Waiting for approval" },
          ],
        },
      },
    });

    expect(partial.waitStateEvents).toEqual([
      {
        cycleSource: "omp-task",
        waitGroupKey: "omp-task:omp-task-1",
        phase: "startOrUpdate",
        items: [
          { itemKey: "child-1", title: "Investigate failing alert", status: "completed", detail: "Found root cause" },
          { itemKey: "child-2", title: "Prepare rollback", status: "running", detail: "Waiting for approval" },
        ],
      },
    ]);

    const finished = __cliRunTestUtils.parseJsonlMessage({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "omp-task-1",
        toolName: "task",
        isError: false,
        content: [{ type: "text", text: "<task-summary>All child tasks done</task-summary>" }],
        details: {
          results: [
            { taskId: "child-2", title: "Prepare rollback", exitCode: 0, output: "Rollback staged" },
          ],
        },
      },
    });

    expect(finished.waitStateEvents).toEqual([
      {
        cycleSource: "omp-task",
        waitGroupKey: "omp-task:omp-task-1",
        phase: "finish",
        items: [
          { itemKey: "child-2", title: "Prepare rollback", status: "completed", detail: "Rollback staged" },
        ],
        summary: "All child tasks done",
      },
    ]);
  });

  it("emits Claude Task wait start and finish events keyed by agent identity", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_task_wait",
            name: "Task",
            input: { description: "Check latest HelpScout tickets" },
          },
        ],
      },
    });

    const started = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_task_wait",
            is_error: false,
            content: "Async agent launched successfully.\nagentId: agent-42",
          },
        ],
      },
    });

    expect(started.waitStateEvents).toEqual([
      {
        cycleSource: "claude-task",
        waitGroupKey: "claude-task:toolu_task_wait",
        phase: "startOrUpdate",
        items: [
          {
            itemKey: "agent-42",
            title: "Check latest HelpScout tickets",
            agentId: "agent-42",
            status: "running",
          },
        ],
      },
    ]);

    const finished = __cliRunTestUtils.parseJsonlMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_task_wait",
            is_error: true,
            content: "Ticket API rate limit exceeded\nagentId: agent-42",
          },
        ],
      },
    });

    expect(finished.waitStateEvents).toEqual([
      {
        cycleSource: "claude-task",
        waitGroupKey: "claude-task:toolu_task_wait",
        phase: "finish",
        items: [
          {
            itemKey: "agent-42",
            title: "Check latest HelpScout tickets",
            agentId: "agent-42",
            status: "failed",
            detail: "Ticket API rate limit exceeded",
          },
        ],
      },
    ]);
  });

  it("emits Codex wait lifecycles for explicit wait calls", () => {
    __cliRunTestUtils.resetParserState();

    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_spawn_wait",
        arguments: JSON.stringify({ message: "Investigate the webhook backlog" }),
      },
    });
    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_wait",
        output: JSON.stringify({ agent_id: "agent-wait-1" }),
      },
    });

    const started = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait",
        call_id: "call_wait_1",
        arguments: JSON.stringify({ ids: ["agent-wait-1"] }),
      },
    });

    expect(started.waitStateEvents).toEqual([
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:call_wait_1",
        phase: "startOrUpdate",
        items: [
          {
            itemKey: "agent-wait-1",
            title: "Investigate the webhook backlog",
            agentId: "agent-wait-1",
            status: "running",
          },
        ],
      },
    ]);

    const finished = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_wait_1",
        output: JSON.stringify({
          status: { "agent-wait-1": { completed: "Webhook queue drained" } },
          timed_out: false,
        }),
      },
    });

    expect(finished.waitStateEvents).toEqual([
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:call_wait_1",
        phase: "finish",
        items: [
          {
            itemKey: "agent-wait-1",
            title: "Investigate the webhook backlog",
            agentId: "agent-wait-1",
            status: "completed",
            detail: "Webhook queue drained",
          },
        ],
      },
    ]);
  });

  it("falls back to resumed Codex wait outputs when prior wait metadata is unavailable", () => {
    __cliRunTestUtils.resetParserState();

    const parsed = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "resume-only-output",
        output: JSON.stringify({
          status: {
            "agent-finished": { completed: true },
            "agent-failed": { failed: "Timed out contacting backend" },
          },
          timed_out: false,
        }),
      },
    });

    expect(parsed.waitStateEvents).toEqual([
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:agent-finished",
        phase: "finish",
        items: [
          { itemKey: "agent-finished", agentId: "agent-finished", status: "completed" },
        ],
      },
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:agent-failed",
        phase: "finish",
        items: [
          {
            itemKey: "agent-failed",
            agentId: "agent-failed",
            status: "failed",
            detail: "Timed out contacting backend",
          },
        ],
      },
    ]);
  });

  it("applies later Codex metadata after a resume-only finish output", () => {
    __cliRunTestUtils.resetParserState();

    const resumed = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "resume-only-output",
        output: JSON.stringify({
          status: { "agent-finished": { completed: true } },
          timed_out: false,
        }),
      },
    });

    expect(resumed.waitStateEvents).toEqual([
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:agent-finished",
        phase: "finish",
        items: [{ itemKey: "agent-finished", agentId: "agent-finished", status: "completed" }],
      },
    ]);

    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_spawn_after_resume",
        arguments: JSON.stringify({ message: "Investigate the webhook backlog" }),
      },
    });
    __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_after_resume",
        output: JSON.stringify({ agent_id: "agent-finished" }),
      },
    });

    const started = __cliRunTestUtils.parseJsonlMessage({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait",
        call_id: "call_wait_after_resume",
        arguments: JSON.stringify({ ids: ["agent-finished"] }),
      },
    });

    expect(started.waitStateEvents).toEqual([
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:call_wait_after_resume",
        phase: "startOrUpdate",
        items: [
          {
            itemKey: "agent-finished",
            title: "Investigate the webhook backlog",
            agentId: "agent-finished",
            status: "running",
          },
        ],
      },
    ]);
  });

});
