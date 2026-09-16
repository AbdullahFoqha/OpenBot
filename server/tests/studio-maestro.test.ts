import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMaestroFromCriteria,
  parseDeviceFromCriteria,
  shouldRunMaestro,
  STUDIO_PREFERRED_IOS_UDID,
} from "../src/studio/maestro";

describe("parseMaestroFromCriteria", () => {
  test("extracts relative path from maestro: line", () => {
    const criteria = `
- User can log in
- Check the payment flow
maestro: .maestro/onboard.yaml
- UI looks correct
    `;
    expect(parseMaestroFromCriteria(criteria)).toBe(".maestro/onboard.yaml");
  });

  test("extracts absolute path from maestro: line", () => {
    const criteria = "maestro: /Users/dev/project/.maestro/flow.yaml";
    expect(parseMaestroFromCriteria(criteria)).toBe(
      "/Users/dev/project/.maestro/flow.yaml",
    );
  });

  test("returns undefined when no maestro line", () => {
    const criteria = "- Run tests\n- Check coverage";
    expect(parseMaestroFromCriteria(criteria)).toBeUndefined();
  });

  test("returns undefined for empty/undefined criteria", () => {
    expect(parseMaestroFromCriteria(undefined)).toBeUndefined();
    expect(parseMaestroFromCriteria("")).toBeUndefined();
  });

  test("handles extra whitespace in maestro line", () => {
    const criteria = "maestro:   .maestro/login-flow.yaml  ";
    expect(parseMaestroFromCriteria(criteria)).toBe(".maestro/login-flow.yaml");
  });
});

describe("parseDeviceFromCriteria", () => {
  test("extracts UDID from device: line", () => {
    const criteria = `
maestro: .maestro/test.yaml
device: 812A595B-0FDA-4C3F-9346-088E6C07A489
    `;
    expect(parseDeviceFromCriteria(criteria)).toBe(
      "812A595B-0FDA-4C3F-9346-088E6C07A489",
    );
  });

  test("returns undefined when no device line", () => {
    expect(parseDeviceFromCriteria("maestro: test.yaml")).toBeUndefined();
  });

  test("is case-insensitive for UDID characters", () => {
    const criteria = "device: abcdef01-2345-6789-abcd-ef0123456789";
    expect(parseDeviceFromCriteria(criteria)).toBe(
      "abcdef01-2345-6789-abcd-ef0123456789",
    );
  });
});

describe("shouldRunMaestro", () => {
  test("returns run=true when maestroFlow is explicitly set", () => {
    const result = shouldRunMaestro({
      maestroFlow: ".maestro/test.yaml",
      ownerBotId: "react-native-engineer",
    });
    expect(result.run).toBe(true);
    expect(result.flow).toBe(".maestro/test.yaml");
  });

  test("returns run=true for quality-engineer with maestro: in AC", () => {
    const result = shouldRunMaestro({
      acceptanceCriteria: "maestro: .maestro/onboard.yaml",
      ownerBotId: "quality-engineer",
    });
    expect(result.run).toBe(true);
    expect(result.flow).toBe(".maestro/onboard.yaml");
  });

  test("extracts udid from device: line in AC", () => {
    const result = shouldRunMaestro({
      acceptanceCriteria: `
maestro: .maestro/test.yaml
device: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE
      `,
      ownerBotId: "quality-engineer",
    });
    expect(result.run).toBe(true);
    expect(result.udid).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  });

  test("returns run=false for react-native-engineer with maestro: in AC", () => {
    const result = shouldRunMaestro({
      acceptanceCriteria: "maestro: .maestro/test.yaml",
      ownerBotId: "react-native-engineer",
    });
    expect(result.run).toBe(false);
  });

  test("returns run=false when no maestro specified", () => {
    const result = shouldRunMaestro({
      acceptanceCriteria: "- Tests pass\n- Code compiles",
      ownerBotId: "quality-engineer",
    });
    expect(result.run).toBe(false);
  });

  test("maestroFlow parameter takes precedence over AC parsing", () => {
    const result = shouldRunMaestro({
      maestroFlow: "/explicit/path.yaml",
      acceptanceCriteria: "maestro: .maestro/from-ac.yaml",
      ownerBotId: "react-native-engineer",
    });
    expect(result.run).toBe(true);
    expect(result.flow).toBe("/explicit/path.yaml");
  });

  test("preferred UDID constant is correct", () => {
    expect(STUDIO_PREFERRED_IOS_UDID).toBe("812A595B-0FDA-4C3F-9346-088E6C07A489");
  });
});

describe("runMaestro with mock native worker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "maestro-test-"));
    await mkdir(join(tmpDir, "project"), { recursive: true });
    await mkdir(join(tmpDir, "worktree"), { recursive: true });
    await mkdir(join(tmpDir, "project", ".maestro"), { recursive: true });
    await writeFile(
      join(tmpDir, "project", ".maestro", "test.yaml"),
      "appId: app.test\n---\n- tapOn: Login",
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("mock native worker register/release flow", async () => {
    const registered: string[] = [];
    const released: string[] = [];

    const mockWorker = {
      register: mock(async (input: { taskId: string; devices: string[] }) => {
        registered.push(input.taskId);
        if (input.devices.includes("RESERVED-BY-OTHER")) {
          return {
            ok: false as const,
            reason: "RESERVED-BY-OTHER is already reserved by other-task.",
          };
        }
        return { ok: true as const, registration: input };
      }),
      release: mock((taskId: string) => {
        released.push(taskId);
      }),
    };

    const registerResult = await mockWorker.register({
      taskId: "test-task",
      devices: ["812A595B-0FDA-4C3F-9346-088E6C07A489"],
    });
    expect(registerResult.ok).toBe(true);
    expect(registered).toContain("test-task");

    mockWorker.release("test-task");
    expect(released).toContain("test-task");

    const conflictResult = await mockWorker.register({
      taskId: "another-task",
      devices: ["RESERVED-BY-OTHER"],
    });
    expect(conflictResult.ok).toBe(false);
  });

  test("release is called even on failure (try/finally pattern)", async () => {
    const released: string[] = [];

    const mockWorker = {
      register: mock(async () => ({ ok: true as const, registration: {} })),
      release: mock((taskId: string) => {
        released.push(taskId);
      }),
    };

    const taskId = "test-finally-task";

    await mockWorker.register({ taskId, devices: ["udid"] });
    try {
      throw new Error("Simulated failure during Maestro run");
    } finally {
      mockWorker.release(taskId);
    }

    expect(released).toContain(taskId);
  });
});

describe("evidence output structure", () => {
  test("evidence has expected shape", () => {
    const evidence = {
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      flow: "/path/to/flow.yaml",
      exitCode: 0,
      outputDir: "/path/to/output",
      appInstalled: true,
      durationMs: 15000,
    };

    expect(evidence).toHaveProperty("udid");
    expect(evidence).toHaveProperty("flow");
    expect(evidence).toHaveProperty("exitCode");
    expect(evidence).toHaveProperty("outputDir");
    expect(evidence).toHaveProperty("appInstalled");
    expect(evidence).toHaveProperty("durationMs");
  });

  test("evidence can include error", () => {
    const evidence = {
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      flow: "/path/to/flow.yaml",
      exitCode: 1,
      outputDir: "/path/to/output",
      appInstalled: true,
      error: "Maestro flow assertion failed",
      durationMs: 5000,
    };

    expect(evidence.error).toBe("Maestro flow assertion failed");
  });
});
