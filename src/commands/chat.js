import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  createMultiProviderApiClient,
  resolveModel,
  resolveProvider,
} from "../ai/client.js";
import { resolveOutputRoot } from "../config/service.js";
import { estimateTokens } from "../cost/tokenizer.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function createSessionId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

async function readPromptFromStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buffer += String(chunk || "");
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(buffer.trim()));
  });
}

async function appendTranscriptEntries({ transcriptPath, entries } = {}) {
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
  const rows = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fsp.appendFile(transcriptPath, `${rows}\n`, "utf-8");
}

export function registerChatCommand(program) {
  const chat = program
    .command("chat")
    .description("Low-latency chat command surface for guided AI interaction");

  chat
    .command("ask")
    .description("Send one prompt and stream/store the response")
    .option("--prompt <text>", "Prompt text. If omitted, reads from STDIN when piped.")
    .option("--provider <provider>", "Provider override (openai|anthropic|google)")
    .option("--model <model>", "Model override")
    .option("--api-key <key>", "Provider API key override")
    .option("--path <path>", "Workspace path for output/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--session-id <id>", "Optional existing session id (append mode)")
    .option("--dry-run", "Skip network call and emit deterministic simulated response")
    .option("--no-stream", "Disable streaming output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const promptFromFlag = String(options.prompt || "").trim();
      const promptFromStdin = promptFromFlag ? "" : await readPromptFromStdin();
      const prompt = String(promptFromFlag || promptFromStdin).trim();
      if (!prompt) {
        throw new Error("Prompt is required. Use --prompt or pipe text to STDIN.");
      }

      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const sessionId = String(options.sessionId || "").trim() || createSessionId();
      const transcriptPath = path.join(outputRoot, "chat", "sessions", `${sessionId}.jsonl`);

      const provider = resolveProvider({
        provider: options.provider,
        env: process.env,
      });
      const model = resolveModel({
        provider,
        model: options.model,
      });

      const startedAt = Date.now();
      let responseText = "";

      if (options.dryRun) {
        responseText = `DRY_RUN_RESPONSE: ${prompt.slice(0, 240)}`;
      } else {
        const streamEnabled = Boolean(options.stream);
        let streamedText = "";
        const client = createMultiProviderApiClient();
        const invocation = await client.invoke({
          provider,
          model,
          prompt,
          apiKey: options.apiKey,
          stream: streamEnabled,
          env: process.env,
          onChunk: streamEnabled
            ? (chunk) => {
                streamedText += chunk;
                if (!emitJson) {
                  process.stdout.write(chunk);
                }
              }
            : undefined,
        });

        responseText = streamEnabled ? streamedText || invocation.text : invocation.text;
        if (streamEnabled && !emitJson) {
          process.stdout.write("\n");
        }
      }

      const durationMs = Date.now() - startedAt;
      const generatedAt = new Date().toISOString();
      const inputTokens = estimateTokens(prompt, { model });
      const outputTokens = estimateTokens(responseText, { model });

      await appendTranscriptEntries({
        transcriptPath,
        entries: [
          {
            timestamp: generatedAt,
            role: "user",
            provider,
            model,
            session_id: sessionId,
            content: prompt,
          },
          {
            timestamp: generatedAt,
            role: "assistant",
            provider,
            model,
            session_id: sessionId,
            dry_run: Boolean(options.dryRun),
            content: responseText,
          },
        ],
      });

      const payload = {
        command: "chat ask",
        sessionId,
        provider,
        model,
        dryRun: Boolean(options.dryRun),
        streamed: Boolean(options.stream),
        transcriptPath,
        prompt,
        response: responseText,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          durationMs,
        },
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!options.stream || options.dryRun) {
        console.log(responseText);
      }
      console.log(pc.gray(`session: ${sessionId}`));
      console.log(pc.gray(`transcript: ${transcriptPath}`));
      console.log(pc.gray(`usage: input=${inputTokens} output=${outputTokens} duration_ms=${durationMs}`));
    });
}
