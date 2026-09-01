import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const binaryInput = process.env.CLAUDE_NATIVE_BINARY;
const liveThinkingTest = binaryInput ? test : test.skip;

const thinkingText = "MOCK_LIVE_THOUGHT";
const finalText = "MOCK_FINAL_ANSWER";

function event(type: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function cleanEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

liveThinkingTest(
  "renders thinking before the final response without live credentials",
  async () => {
    const binaryPath = isAbsolute(binaryInput!) ? binaryInput! : resolve(binaryInput!);
    expect(await Bun.file(binaryPath).exists()).toBe(true);

    let finalEventSent = false;
    let requestReceived = false;
    let sawThinkingBeforeFinalEvent = false;
    const configDir = await mkdtemp(join(tmpdir(), "claude-live-thinking-test-"));
    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        hasTrustDialogAccepted: true,
        numStartups: 1,
        projects: {
          [process.cwd()]: {
            hasTrustDialogAccepted: true,
          },
        },
        theme: "dark",
      }),
      { mode: 0o600 }
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
          return Response.json({ error: "not found" }, { status: 404 });
        }

        requestReceived = true;
        const stream = new ReadableStream({
          async start(controller) {
            const send = (type: string, data: unknown) => controller.enqueue(event(type, data));
            send("message_start", {
              type: "message_start",
              message: {
                id: "msg_mock_live_thinking",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            });
            send("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: thinkingText },
            });
            await Bun.sleep(1500);
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "mock-signature" },
            });
            send("content_block_stop", { type: "content_block_stop", index: 0 });
            finalEventSent = true;
            send("content_block_start", {
              type: "content_block_start",
              index: 1,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: finalText },
            });
            send("content_block_stop", { type: "content_block_stop", index: 1 });
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 2 },
            });
            send("message_stop", { type: "message_stop" });
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      },
    });

    const processHandle = Bun.spawn(
      ["python3", join(import.meta.dir, "helpers", "run-claude-pty.py"), binaryPath],
      {
        env: cleanEnvironment({
          ANTHROPIC_AUTH_TOKEN: "credential-free-test-token",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CONFIG_DIR: configDir,
          NO_PROXY: "127.0.0.1,localhost",
        }),
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const stderrPromise = new Response(processHandle.stderr).text();

    let output = "";
    const reader = processHandle.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        output += chunk;
        if (!finalEventSent && output.includes(thinkingText)) {
          sawThinkingBeforeFinalEvent = true;
        }
      }
      output += decoder.decode();
      const exitCode = await processHandle.exited;
      const stderr = await stderrPromise;

      expect(exitCode, `${stderr}\n${output}`).toBe(0);
      expect(requestReceived).toBe(true);
      expect(output).toContain(finalText);
      expect(sawThinkingBeforeFinalEvent, `${stderr}\n${output}`).toBe(true);
    } finally {
      server.stop(true);
      processHandle.kill();
      await rm(configDir, { recursive: true, force: true });
    }
  },
  30_000
);
