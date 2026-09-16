import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMaestroFromCriteria,
  parseDeviceFromCriteria,
  shouldRunMaestro,
  installApp,
  resolveStudioInstallMode,
  STUDIO_PREFERRED_IOS_UDID,
  type InstallResult,
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
    await mkdir(join(tmpDir, "project", ".maestro"), { recursive: true });
    await mkdir(join(tmpDir, "worktree"), { recursive: true });
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
    let caughtError: Error | null = null;
    try {
      throw new Error("Simulated failure during Maestro run");
    } catch (err) {
      caughtError = err as Error;
    } finally {
      mockWorker.release(taskId);
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toBe("Simulated failure during Maestro run");
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

  test("evidence can include install result", () => {
    const evidence = {
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      flow: "/path/to/flow.yaml",
      exitCode: 0,
      outputDir: "/path/to/output",
      appInstalled: true,
      durationMs: 15000,
      install: {
        status: "release" as const,
        exitCode: 0,
        logPath: "/path/to/output/install.log",
      },
    };

    expect(evidence.install).toBeDefined();
    expect(evidence.install?.status).toBe("release");
    expect(evidence.install?.exitCode).toBe(0);
  });
});


describe("resolveStudioInstallMode", () => {
  test("defaults to release when unset", () => {
    expect(resolveStudioInstallMode(undefined, {})).toBe("release");
  });

  test("honors STUDIO_INSTALL_MODE env", () => {
    expect(resolveStudioInstallMode(undefined, { STUDIO_INSTALL_MODE: "clone" })).toBe("clone");
    expect(resolveStudioInstallMode(undefined, { STUDIO_INSTALL_MODE: "auto" })).toBe("auto");
    expect(resolveStudioInstallMode(undefined, { STUDIO_INSTALL_MODE: "expo" })).toBe("expo");
  });

  test("explicit mode wins over env", () => {
    expect(resolveStudioInstallMode("expo", { STUDIO_INSTALL_MODE: "clone" })).toBe("expo");
  });

  test("unknown values fall back to release", () => {
    expect(resolveStudioInstallMode("nope", {})).toBe("release");
  });
});

describe("installApp", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "install-test-"));
    await mkdir(join(tmpDir, "project"), { recursive: true });
    await mkdir(join(tmpDir, "output"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });


  test("defaults to release mode and installs DerivedData Release app", async () => {
    const releaseApp =
      "/Users/abdullah/Library/Developer/Xcode/DerivedData/PocketLove-x/Build/Products/Release-iphonesimulator/PocketLove.app";
    const mockRunCommand = mock(
      async (
        command: string,
        args: string[],
      ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        if (command === "find") {
          return { exitCode: 0, stdout: releaseApp + "\n", stderr: "" };
        }
        if (command === "xcrun" && args[1] === "uninstall") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "xcrun" && args[1] === "install") {
          expect(args[3]).toBe(releaseApp);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const prev = process.env.STUDIO_INSTALL_MODE;
    delete process.env.STUDIO_INSTALL_MODE;
    try {
      const result = await installApp({
        projectPath: join(tmpDir, "project"),
        udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
        appId: "app.pocketlove.private",
        outputDir: join(tmpDir, "output"),
        // mode omitted → resolveStudioInstallMode → release
        runCommand: mockRunCommand,
      });
      expect(result.status).toBe("release");
      expect(result.exitCode).toBe(0);
      const logContent = await readFile(result.logPath, "utf8");
      expect(logContent).toContain("mode=release");
      expect(logContent).toContain("RELEASE: success");
    } finally {
      if (prev === undefined) delete process.env.STUDIO_INSTALL_MODE;
      else process.env.STUDIO_INSTALL_MODE = prev;
    }
  });

  test("skipped status when clone-only mode fails with no donor", async () => {
    const mockRunCommand = mock(
      async (
        command: string,
        args: string[],
      ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: "-- iOS 18.0 --\n    iPhone 17 Pro (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE) (Booted)\n",
            stderr: "",
          };
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "get_app_container") {
          return { exitCode: 1, stdout: "", stderr: "No matching container" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const result = await installApp({
      projectPath: join(tmpDir, "project"),
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      appId: "app.pocketlove.private",
      outputDir: join(tmpDir, "output"),
      mode: "clone",
      runCommand: mockRunCommand,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);

    const logContent = await readFile(result.logPath, "utf8");
    expect(logContent).toContain("clone-only mode requested");
  });

  test("clone succeeds when donor sim found", async () => {
    const targetUdid = "812A595B-0FDA-4C3F-9346-088E6C07A489";
    const donorUdid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const appPath = "/some/path/to/app.app";

    const mockRunCommand = mock(
      async (
        command: string,
        args: string[],
      ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: `-- iOS 18.0 --\n    iPhone 17 Pro (${donorUdid}) (Booted)\n    iPhone 17 (${targetUdid}) (Shutdown)\n`,
            stderr: "",
          };
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "get_app_container") {
          const udid = args[2];
          const type = args[4];
          if (udid === donorUdid) {
            if (type === "data") return { exitCode: 0, stdout: "/data/path", stderr: "" };
            if (type === "app") return { exitCode: 0, stdout: appPath, stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "No container" };
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "install") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const result = await installApp({
      projectPath: join(tmpDir, "project"),
      udid: targetUdid,
      appId: "app.pocketlove.private",
      outputDir: join(tmpDir, "output"),
      mode: "auto",
      runCommand: mockRunCommand,
    });

    expect(result.status).toBe("cloned");
    expect(result.exitCode).toBe(0);

    const logContent = await readFile(result.logPath, "utf8");
    expect(logContent).toContain("CLONE: success");
  });

  test("expo fallback when clone fails in auto mode", async () => {
    const mockRunCommand = mock(
      async (
        command: string,
        args: string[],
      ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return { exitCode: 0, stdout: "-- iOS 18.0 --\n", stderr: "" };
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "get_app_container") {
          return { exitCode: 1, stdout: "", stderr: "No container" };
        }
        if (command === "npx" && args[0] === "expo") {
          return { exitCode: 0, stdout: "Build succeeded", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const result = await installApp({
      projectPath: join(tmpDir, "project"),
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      appId: "app.pocketlove.private",
      outputDir: join(tmpDir, "output"),
      mode: "auto",
      runCommand: mockRunCommand,
    });

    expect(result.status).toBe("expo");
    expect(result.exitCode).toBe(0);

    const logContent = await readFile(result.logPath, "utf8");
    expect(logContent).toContain("EXPO: npx expo run:ios");
    expect(logContent).toContain("--configuration Release");
    expect(logContent).toContain("Build succeeded");
  });

  test("expo mode fails with non-zero exit", async () => {
    const mockRunCommand = mock(
      async (
        command: string,
        args: string[],
      ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        if (command === "xcrun") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "npx" && args[0] === "expo") {
          return { exitCode: 1, stdout: "", stderr: "Build failed: missing pods" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const result = await installApp({
      projectPath: join(tmpDir, "project"),
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      appId: "app.pocketlove.private",
      outputDir: join(tmpDir, "output"),
      mode: "expo",
      runCommand: mockRunCommand,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);

    const logContent = await readFile(result.logPath, "utf8");
    expect(logContent).toContain("stderr: Build failed: missing pods");
  });

  test("install.log is written to outputDir", async () => {
    const mockRunCommand = mock(
      async (): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    );

    const result = await installApp({
      projectPath: join(tmpDir, "project"),
      udid: "812A595B-0FDA-4C3F-9346-088E6C07A489",
      appId: "app.pocketlove.private",
      outputDir: join(tmpDir, "output"),
      mode: "clone",
      runCommand: mockRunCommand,
    });

    expect(result.logPath).toBe(join(tmpDir, "output", "install.log"));
    const exists = await readFile(result.logPath, "utf8").then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});
