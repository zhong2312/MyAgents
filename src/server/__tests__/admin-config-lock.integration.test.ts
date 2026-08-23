import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("admin config lock", () => {
  it("serializes concurrent config.json mutations across processes", async () => {
    const home = mkdtempSync(join(tmpdir(), "myagents-config-lock-"));
    const configDir = join(home, ".myagents");
    const configPath = join(configDir, "config.json");
    const adminConfigUrl = pathToFileURL(
      join(process.cwd(), "src/server/utils/admin-config.ts"),
    ).href;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ initial: true }, null, 2),
      "utf-8",
    );

    const runMutation = (key: string, value: string, holdMs: number) =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          `
          const { atomicModifyConfig } = await import(${JSON.stringify(adminConfigUrl)});
          await atomicModifyConfig(async (config) => {
            if (${holdMs} > 0) {
              await new Promise(r => setTimeout(r, ${holdMs}));
            }
            return { ...config, ${JSON.stringify(key)}: ${JSON.stringify(value)} };
          });
        `,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          },
        },
      );

    try {
      await Promise.all([
        runMutation("first", "a", 300),
        runMutation("second", "b", 0),
      ]);

      const finalConfig = JSON.parse(
        readFileSync(configPath, "utf-8"),
      ) as Record<string, unknown>;
      expect(finalConfig).toMatchObject({
        initial: true,
        first: "a",
        second: "b",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);

  it("preserves agent-config-intent.lock identity on timeout", async () => {
    const home = mkdtempSync(join(tmpdir(), "myagents-intent-lock-"));
    const configDir = join(home, ".myagents");
    const lockDir = join(configDir, "agent-config-intent.lock");
    const adminConfigUrl = pathToFileURL(
      join(process.cwd(), "src/server/utils/admin-config.ts"),
    ).href;

    mkdirSync(lockDir, { recursive: true });
    // A legacy 2-tuple is enough to prove the owner process is alive without
    // conflating this timeout fixture with v1 start-time diagnostics.
    writeFileSync(join(lockDir, "owner"), `node:${process.pid}\n`, "utf-8");

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          `
          const { withAgentConfigIntentLock } = await import(${JSON.stringify(adminConfigUrl)});
          try {
            await withAgentConfigIntentLock(async () => undefined);
          } catch (error) {
            console.log(JSON.stringify({ code: error.code, message: error.message }));
          }
        `,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          },
        },
      );

      expect(JSON.parse(stdout.trim())).toMatchObject({
        code: "AGENT_CONFIG_INTENT_BUSY",
      });
      expect(stdout).toContain("agent-config-intent.lock");
      expect(stdout).not.toContain("config.json.lock");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});
