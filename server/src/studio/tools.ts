/**
 * Bot-callable Studio tools: start Cursor CLI work the same way the dashboard Run Task does.
 *
 * Lead must use these for product coding/QA — not host-folder writes. Implementation runs as
 * react-native-engineer; independent verify can run as quality-engineer.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";
import type { Database } from "../db/client";
import { studioEvidence, studioPullRequests, studioTasks } from "../db/schema";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import type { StudioDispatcher } from "./dispatch";
import { STUDIO_PRODUCT_ID } from "./dispatch";
import {
  formatProductInspectForChat,
  inspectSelectedProduct,
} from "./product-inspect";
import { getSelectedProduct } from "./products";
import { resolveProjectPath } from "./project-path";
import { ghRunner } from "./github";
import { resolveRepository } from "./project-delivery";
import type { TaskStore } from "./task-store";
import { createDynamicBot } from "./bot-catalog";
import type { BotMessaging } from "./bot-messaging";
import type { StudioChannelBus } from "./studio-channels";
import type { StudioMemoryStore } from "./studio-memory";
import type { StudioSkillPackStore } from "./studio-skill-packs";
import type { StudioRoutineBus } from "./studio-routines";
import type { StudioMcpBus } from "./studio-mcp-connectors";
import type { StudioBotSecretStore } from "./studio-bot-secrets";
import { STUDIO_VERIFIER_BOT_ID } from "./studio-verifier";
import {
  getBrowserSession,
  startBrowserSession,
  stopBrowserSession,
  type BrowserStep,
} from "./browser-session";
import {
  runDesktopActions,
  getDesktopSession,
  startDesktopSession,
  stopDesktopSession,
  type DesktopStep,
} from "./desktop-session";

const runTaskParams = z.object({
  title: z.string().min(1).describe("Short task title for the Studio queue and branch name."),
  goal: z
    .string()
    .min(1)
    .describe(
      "What the worker must do in the selected project (implement, or for QA: verify/run tests on a branch/worktree).",
    ),
  acceptanceCriteria: z
    .string()
    .optional()
    .describe("How to know the task succeeded. Prefer concrete file, test, and PR checks. For Maestro UI verification, include a line like 'maestro: .maestro/flow.yaml'."),
  idempotencyKey: z
    .string()
    .optional()
    .describe("Optional key so a retried call does not start a second identical task."),
  ownerBotId: z
    .enum(["react-native-engineer", "quality-engineer", "technical-lead", "studio-verifier"])
    .optional()
    .describe(
      "Who owns the Cursor run. Default react-native-engineer for implementation. Use quality-engineer for QA/Maestro; use studio-verifier for Mac-evidence-only claim checks (no feature implement).",
    ),
  skipVerify: z
    .boolean()
    .optional()
    .describe("Set true only to skip automatic npm test/typecheck after the worker (rare)."),
  maestroFlow: z
    .string()
    .optional()
    .describe(
      "Path to a Maestro YAML flow file (relative to project root or absolute). When set with ownerBotId=quality-engineer, runs Maestro UI tests after npm verification. Default device: iPhone 17 Pro (812A595B-0FDA-4C3F-9346-088E6C07A489).",
    ),
  deviceUdid: z
    .string()
    .optional()
    .describe("iOS Simulator UDID for Maestro tests. Defaults to studio's preferred device (iPhone 17 Pro)."),
  background: z
    .boolean()
    .optional()
    .describe(
      "P2.2: true = review/background slot (safe parallel beyond 1 primary per Bot). Default true for studio-verifier. Engineer feature work should leave this unset/false.",
    ),
});

const taskIdParams = z.object({
  taskId: z.string().min(1).describe("Studio task id, e.g. task-…"),
});


const spawnBotParams = z.object({
  id: z
    .string()
    .min(2)
    .describe("Kebab-case bot id slug, e.g. custom-researcher-demo. Must not collide with built-ins."),
  name: z.string().min(1).describe("Display name."),
  title: z.string().optional().describe("Short role title chip."),
  systemPrompt: z
    .string()
    .optional()
    .describe("Role instructions. Required unless templateRoleId is set."),
  templateRoleId: z
    .string()
    .optional()
    .describe("Copy systemPrompt from a built-in (e.g. product-researcher) as a starting point."),
  avatarSeed: z.string().optional(),
  capabilities: z
    .array(z.string())
    .optional()
    .describe(
      "Phase 1 chat/role only by default. Include cursor_execute only when Phase 1b is enabled; default omit.",
    ),
});


const messageBotParams = z.object({
  botId: z.string().min(1).describe("Target bot id, e.g. custom-researcher-demo or product-researcher."),
  message: z.string().min(1).describe("What to tell that bot."),
  priority: z
    .boolean()
    .optional()
    .describe(
      "true (default): wake them now (Grok SendToAgent priority). false: FYI — inbox + roster only, no wake.",
    ),
  fromBotId: z
    .string()
    .optional()
    .describe("Sender bot id. Default studio-lead."),
});

const browserSessionParams = z.object({
  action: z
    .enum(["start", "stop", "status"])
    .describe("start opens a persistent Chromium session; stop closes it; status returns the last/current session."),
  url: z
    .string()
    .optional()
    .describe("Required for start. Absolute http(s) URL to navigate first."),
  steps: z
    .array(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("wait"), ms: z.number() }),
        z.object({ action: z.literal("screenshot"), name: z.string().optional() }),
        z.object({ action: z.literal("click"), selector: z.string() }),
        z.object({ action: z.literal("type"), selector: z.string(), text: z.string() }),
      ]),
    )
    .optional()
    .describe("Optional steps after navigation. A 01-after-nav screenshot is always taken."),
  headless: z
    .boolean()
    .optional()
    .describe("Default true for unattended runs. Set false only when a visible window is needed."),
});

const desktopStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({ action: z.literal("screenshot"), name: z.string().optional() }),
  z.object({ action: z.literal("activate"), app: z.string() }),
  z.object({ action: z.literal("open"), app: z.string() }),
  z.object({ action: z.literal("type"), text: z.string(), app: z.string().optional() }),
  z.object({ action: z.literal("keystroke"), text: z.string() }),
  z.object({ action: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({
    action: z.literal("quit"),
    app: z.string(),
    saving: z.enum(["yes", "no", "ask"]).optional(),
  }),
]);

const desktopSessionParams = z.object({
  action: z
    .enum(["start", "stop", "status", "action"])
    .describe("start opens a Mac GUI session; action runs steps; stop closes; status returns last/current."),
  app: z
    .string()
    .optional()
    .describe("Optional app to open/focus on start (e.g. TextEdit, Calculator, Simulator)."),
  steps: z
    .array(desktopStepSchema)
    .optional()
    .describe("Scripted steps: wait/screenshot/activate/open/type/keystroke/click/quit."),
});


const createChannelParams = z.object({
  name: z.string().min(1).describe("Room display name."),
  memberBotIds: z
    .array(z.string())
    .min(1)
    .describe("Bot ids to seat (built-in and/or dynamic), e.g. studio-lead, custom-researcher-demo."),
});

const channelMessageParams = z.object({
  channelId: z.string().min(1).describe("Studio channel id from studio_create_channel (studio-ch-…)."),
  message: z.string().min(1).describe("Text to post for all members to see."),
  fromBotId: z.string().optional().describe("Defaults to the calling bot."),
});


const memoryWriteParams = z.object({
  fact: z.string().min(1).describe("One self-contained sentence to remember."),
  scope: z
    .enum(["agent", "user"])
    .optional()
    .describe("agent = this bot only (default); user = shared across Studio bots."),
  tier: z
    .enum(["profile", "log", "note"])
    .optional()
    .describe("profile = foundational; log = dated history (default); note = low weight."),
  botId: z
    .string()
    .optional()
    .describe("Target bot for agent scope. Defaults to the calling bot."),
});

const memoryRecallParams = z.object({
  query: z.string().optional().describe("Optional substring filter."),
  scope: z
    .enum(["agent", "user", "all"])
    .optional()
    .describe("all = this bot's agent facts + shared user facts (default)."),
  botId: z.string().optional().describe("Defaults to the calling bot for agent/all scopes."),
  limit: z.number().optional(),
});


const skillPackCreateParams = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  skills: z
    .array(
      z.object({
        slug: z.string().min(1),
        title: z.string().min(1),
        summary: z.string().min(1),
        instructions: z.string().min(1),
      }),
    )
    .min(1),
});

const skillPackAttachParams = z.object({
  packId: z.string().min(1),
  botId: z.string().min(1).describe("Role/bot to attach the pack to."),
});

const skillPackListParams = z.object({
  botId: z.string().optional().describe("If set, list packs attached to this bot; else list all packs."),
});


const verifyClaimParams = z.object({
  title: z.string().min(1).describe("Short verify task title."),
  claim: z
    .string()
    .min(1)
    .describe("The claim or acceptance criteria to verify with Mac evidence only."),
  idempotencyKey: z.string().optional(),
  maestroFlow: z.string().optional().describe("Optional Maestro flow if native UI evidence is required."),
  deviceUdid: z.string().optional(),
});


const routineCreateParams = z.object({
  instruction: z
    .string()
    .min(1)
    .describe(
      "Standing instruction for the Bot when the schedule fires. For unattended Studio work, tell Lead to call studio_run_task with a concrete title/goal/AC.",
    ),
  cron: z
    .string()
    .min(1)
    .describe(
      "Five-field cron (min hour day-of-month month day-of-week). Floor: at most every 15 minutes.",
    ),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone. Default America/New_York."),
  agentId: z
    .string()
    .optional()
    .describe("Which Bot runs the turn. Default studio-lead."),
  channelId: z
    .string()
    .optional()
    .describe("Optional shared channel id. Default: DM with the agent."),
});

const routineIdParams = z.object({
  routineId: z.string().min(1).describe("Routine id (routine_…)."),
});


const mcpInstallParams = z.object({
  key: z
    .string()
    .min(1)
    .describe("Catalogue key (e.g. routines, google-drive, notion)."),
  instanceHost: z.string().optional().describe("Only for per-instance catalogue entries."),
});

const mcpServerIdParams = z.object({
  serverId: z.string().min(1).describe("Installed server id / catalogue key."),
});


const secretSetParams = z.object({
  botId: z.string().min(1).describe("Bot that owns the secret (e.g. studio-lead, react-native-engineer)."),
  name: z
    .string()
    .min(1)
    .describe("Env-style name (letters, digits, underscore), e.g. PENPOT_API_TOKEN."),
  value: z.string().min(1).describe("Secret value. Stored encrypted; never returned by list."),
});

const secretListParams = z.object({
  botId: z.string().min(1).describe("Bot whose secrets to list (names only)."),
});

const secretDeleteParams = z.object({
  botId: z.string().min(1),
  name: z.string().min(1),
});

export function studioTools(options: {
  dispatcher: StudioDispatcher;
  database: Database;
  taskStore: TaskStore;
  allowedBotIds?: readonly string[];
  botMessaging?: BotMessaging;
  studioChannelBus?: StudioChannelBus;
  studioMemory?: StudioMemoryStore;
  skillPackStore?: StudioSkillPackStore;
  /** P2.1 scheduled routines (wraps RoutineStore). */
  studioRoutineBus?: StudioRoutineBus;
  /** P2.3 MCP connector install/auth. */
  studioMcpBus?: StudioMcpBus;
  /** P2.4 bot-scoped secrets. */
  studioSecretStore?: StudioBotSecretStore;
  /** Default actor for headless messaging (studio local user). */
  messagingActorId?: string;
}): (botId: string) => GrantedTool[] {
  const { dispatcher, database, taskStore, allowedBotIds, botMessaging, studioChannelBus, studioMemory, skillPackStore, studioRoutineBus, studioMcpBus, studioSecretStore, messagingActorId } = options;

  return (botId: string) => {
    if (allowedBotIds && !allowedBotIds.includes(botId)) return [];

    const tools: GrantedTool[] = [
      {
        name: "studio_skill_pack_create",
        ref: "studio/skill_pack_create",
        description:
          "Create a skill pack (named set of skills) that can later be attached to bot roles via studio_skill_pack_attach.",
        parameters: skillPackCreateParams,
        execute: async (args) => {
          if (!skillPackStore) {
            return `${REFUSAL_MARKER} Skill packs are not wired in this deployment.`;
          }
          const parsed = skillPackCreateParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} name and skills[] are required.`;
          }
          const result = await skillPackStore.create(parsed.data);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, packId: result.pack.id, pack: result.pack });
        },
      },
      {
        name: "studio_skill_pack_attach",
        ref: "studio/skill_pack_attach",
        description:
          "Attach a skill pack to a bot role: upserts skills and grants them (plugin_grants kind=skill).",
        parameters: skillPackAttachParams,
        execute: async (args) => {
          if (!skillPackStore) {
            return `${REFUSAL_MARKER} Skill packs are not wired in this deployment.`;
          }
          const parsed = skillPackAttachParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} packId and botId are required.`;
          }
          const result = await skillPackStore.attach({
            ...parsed.data,
            by: messagingActorId ?? "dev-local-user",
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            packId: result.pack.id,
            botId: result.botId,
            grantedSlugs: result.grantedSlugs,
          });
        },
      },
      {
        name: "studio_skill_pack_list",
        ref: "studio/skill_pack_list",
        description: "List all skill packs, or packs attached to a bot when botId is set.",
        parameters: skillPackListParams,
        execute: async (args) => {
          if (!skillPackStore) {
            return `${REFUSAL_MARKER} Skill packs are not wired in this deployment.`;
          }
          const parsed = skillPackListParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} invalid list args.`;
          }
          const packs = parsed.data.botId
            ? await skillPackStore.listForBot(parsed.data.botId)
            : await skillPackStore.list();
          return JSON.stringify({ ok: true, packs, count: packs.length });
        },
      },



      {
        name: "studio_secret_set",
        ref: "studio/secret_set",
        description:
          "Store a bot-scoped secret (Grok secret-request parity). Value is encrypted; list never returns it. Use for API tokens a Bot needs.",
        parameters: secretSetParams,
        execute: async (args) => {
          if (!studioSecretStore) {
            return `${REFUSAL_MARKER} Studio secrets are not wired in this deployment.`;
          }
          const parsed = secretSetParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} botId, name, and value are required.`;
          }
          const result = await studioSecretStore.set({
            ...parsed.data,
            by: messagingActorId ?? "dev-local-user",
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            created: result.created,
            secret: result.secret,
            note: "Plaintext is not returned. Use studio_secret_list for names only.",
          });
        },
      },
      {
        name: "studio_secret_list",
        ref: "studio/secret_list",
        description: "List secret names for a bot (never values).",
        parameters: secretListParams,
        execute: async (args) => {
          if (!studioSecretStore) {
            return `${REFUSAL_MARKER} Studio secrets are not wired in this deployment.`;
          }
          const parsed = secretListParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} botId is required.`;
          }
          const secrets = await studioSecretStore.list(parsed.data.botId);
          return JSON.stringify({ ok: true, botId: parsed.data.botId, secrets, count: secrets.length });
        },
      },
      {
        name: "studio_secret_delete",
        ref: "studio/secret_delete",
        description: "Delete a bot-scoped secret by name.",
        parameters: secretDeleteParams,
        execute: async (args) => {
          if (!studioSecretStore) {
            return `${REFUSAL_MARKER} Studio secrets are not wired in this deployment.`;
          }
          const parsed = secretDeleteParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} botId and name are required.`;
          }
          const result = await studioSecretStore.remove(parsed.data.botId, parsed.data.name);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, deleted: { botId: parsed.data.botId, name: parsed.data.name } });
        },
      },

      {
        name: "studio_mcp_catalogue",
        ref: "studio/mcp_catalogue",
        description:
          "List curated MCP connectors (install/auth status). Use before studio_mcp_install or studio_mcp_connect.",
        parameters: z.object({}),
        execute: async () => {
          if (!studioMcpBus) {
            return `${REFUSAL_MARKER} Studio MCP connectors are not wired in this deployment.`;
          }
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await studioMcpBus.catalogue(actorId);
          return JSON.stringify({ ok: true, ...result });
        },
      },
      {
        name: "studio_mcp_install",
        ref: "studio/mcp_install",
        description:
          "Install a curated MCP connector from the catalogue (URL pinned; no arbitrary hosts). Then use studio_mcp_connect for user-oauth connectors.",
        parameters: mcpInstallParams,
        execute: async (args) => {
          if (!studioMcpBus) {
            return `${REFUSAL_MARKER} Studio MCP connectors are not wired in this deployment.`;
          }
          const parsed = mcpInstallParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} key is required.`;
          }
          const result = await studioMcpBus.install({
            key: parsed.data.key.trim(),
            instanceHost: parsed.data.instanceHost,
            by: messagingActorId ?? "dev-local-user",
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, server: result.server });
        },
      },
      {
        name: "studio_mcp_status",
        ref: "studio/mcp_status",
        description:
          "Auth/install status for installed MCP connectors (or one serverId). Values: ready | needs_install | needs_auth | needs_public_url | error.",
        parameters: z.object({
          serverId: z.string().optional(),
        }),
        execute: async (args) => {
          if (!studioMcpBus) {
            return `${REFUSAL_MARKER} Studio MCP connectors are not wired in this deployment.`;
          }
          const serverId =
            typeof (args as { serverId?: string } | null)?.serverId === "string"
              ? (args as { serverId: string }).serverId
              : undefined;
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await studioMcpBus.status(actorId, serverId);
          return JSON.stringify({ ok: true, ...result });
        },
      },
      {
        name: "studio_mcp_connect",
        ref: "studio/mcp_connect",
        description:
          "Start per-person OAuth for an installed user-oauth MCP connector. Returns authorizationUrl for the human to open. Builtin connectors need install only.",
        parameters: mcpServerIdParams,
        execute: async (args) => {
          if (!studioMcpBus) {
            return `${REFUSAL_MARKER} Studio MCP connectors are not wired in this deployment.`;
          }
          const parsed = mcpServerIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} serverId is required.`;
          }
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await studioMcpBus.connectStart({
            serverId: parsed.data.serverId.trim(),
            userId: actorId,
            by: actorId,
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            serverId: result.serverId,
            authorizationUrl: result.authorizationUrl,
            note: "Open authorizationUrl in a browser to complete consent, then studio_mcp_status.",
          });
        },
      },

      {
        name: "studio_routine_create",
        ref: "studio/routine_create",
        description:
          "Create a scheduled studio routine (Grok routines parity). Cron fires an unattended Bot turn; instruct studio-lead to call studio_run_task for product work. Floor: every 15 minutes max.",
        parameters: routineCreateParams,
        execute: async (args) => {
          if (!studioRoutineBus) {
            return `${REFUSAL_MARKER} Studio routines are not wired in this deployment.`;
          }
          const parsed = routineCreateParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} instruction and cron are required.`;
          }
          const ownerUserId = messagingActorId ?? "dev-local-user";
          const agentId = parsed.data.agentId?.trim() || "studio-lead";
          const result = await studioRoutineBus.create({
            ownerUserId,
            agentId,
            instruction: parsed.data.instruction,
            cron: parsed.data.cron,
            timezone: parsed.data.timezone,
            channelId: parsed.data.channelId,
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            routine: {
              id: result.routine.id,
              agentId: result.routine.agentId,
              channelId: result.routine.channelId,
              instruction: result.routine.instruction,
              cron: result.routine.cron,
              timezone: result.routine.timezone,
              enabled: result.routine.enabled,
              nextRunAt: result.routine.nextRunAt.toISOString(),
            },
          });
        },
      },
      {
        name: "studio_routine_list",
        ref: "studio/routine_list",
        description: "List this user's studio routines (id, schedule, enabled, nextRunAt, channel).",
        parameters: z.object({}),
        execute: async () => {
          if (!studioRoutineBus) {
            return `${REFUSAL_MARKER} Studio routines are not wired in this deployment.`;
          }
          const ownerUserId = messagingActorId ?? "dev-local-user";
          const routines = await studioRoutineBus.list(ownerUserId);
          return JSON.stringify({
            ok: true,
            count: routines.length,
            routines: routines.map((r) => ({
              id: r.id,
              agentId: r.agentId,
              instruction: r.instruction,
              schedule: r.schedule,
              cronHint: r.schedule,
              timezone: r.timezone,
              enabled: r.enabled,
              nextRunAt: r.nextRunAt.toISOString(),
              channelId: r.channelId,
              channelName: r.channelName,
              channelDeleted: r.channelDeleted,
              lastRun: r.lastRun
                ? {
                    status: r.lastRun.status,
                    finishedAt: r.lastRun.finishedAt?.toISOString() ?? null,
                  }
                : null,
            })),
          });
        },
      },
      {
        name: "studio_routine_pause",
        ref: "studio/routine_pause",
        description: "Pause (disable) a studio routine so it stops firing until resumed.",
        parameters: routineIdParams,
        execute: async (args) => {
          if (!studioRoutineBus) {
            return `${REFUSAL_MARKER} Studio routines are not wired in this deployment.`;
          }
          const parsed = routineIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} routineId is required.`;
          }
          const ownerUserId = messagingActorId ?? "dev-local-user";
          const result = await studioRoutineBus.pause(ownerUserId, parsed.data.routineId);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, routineId: parsed.data.routineId, enabled: false });
        },
      },
      {
        name: "studio_routine_resume",
        ref: "studio/routine_resume",
        description: "Resume (enable) a paused studio routine.",
        parameters: routineIdParams,
        execute: async (args) => {
          if (!studioRoutineBus) {
            return `${REFUSAL_MARKER} Studio routines are not wired in this deployment.`;
          }
          const parsed = routineIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} routineId is required.`;
          }
          const ownerUserId = messagingActorId ?? "dev-local-user";
          const result = await studioRoutineBus.resume(ownerUserId, parsed.data.routineId);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, routineId: parsed.data.routineId, enabled: true });
        },
      },
      {
        name: "studio_routine_delete",
        ref: "studio/routine_delete",
        description: "Delete a studio routine permanently.",
        parameters: routineIdParams,
        execute: async (args) => {
          if (!studioRoutineBus) {
            return `${REFUSAL_MARKER} Studio routines are not wired in this deployment.`;
          }
          const parsed = routineIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} routineId is required.`;
          }
          const ownerUserId = messagingActorId ?? "dev-local-user";
          const result = await studioRoutineBus.remove(ownerUserId, parsed.data.routineId);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, deleted: parsed.data.routineId });
        },
      },
      {
        name: "studio_memory_write",
        ref: "studio/memory_write",
        description:
          "Persist a durable memory fact (Grok update_state memory parity). scope=agent stores per-bot; scope=user is shared across Studio bots. Use tier profile sparingly.",
        parameters: memoryWriteParams,
        execute: async (args) => {
          if (!studioMemory) {
            return `${REFUSAL_MARKER} Studio memory is not wired in this deployment.`;
          }
          const parsed = memoryWriteParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} fact is required.`;
          }
          const scope = parsed.data.scope ?? "agent";
          const result = await studioMemory.write({
            fact: parsed.data.fact,
            scope,
            tier: parsed.data.tier,
            botId: scope === "agent" ? parsed.data.botId?.trim() || botId : undefined,
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, memory: result.memory });
        },
      },
      {
        name: "studio_memory_recall",
        ref: "studio/memory_recall",
        description:
          "Recall durable memories. Default scope=all returns this bot's agent facts plus shared user facts. Optional query substring filter.",
        parameters: memoryRecallParams,
        execute: async (args) => {
          if (!studioMemory) {
            return `${REFUSAL_MARKER} Studio memory is not wired in this deployment.`;
          }
          const parsed = memoryRecallParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} invalid recall args.`;
          }
          const memories = await studioMemory.recall({
            query: parsed.data.query,
            scope: parsed.data.scope ?? "all",
            botId: parsed.data.botId?.trim() || botId,
            limit: parsed.data.limit,
          });
          return JSON.stringify({ ok: true, memories, count: memories.length });
        },
      },

      {
        name: "studio_create_channel",
        ref: "studio/create_channel",
        description:
          "Create a multi-bot room (Grok CreateChannel parity). Seats memberBotIds in one channel; returns studio channel id. Then use studio_channel_message to post so all members can list it.",
        parameters: createChannelParams,
        execute: async (args) => {
          if (!studioChannelBus) {
            return `${REFUSAL_MARKER} Studio channels are not wired in this deployment.`;
          }
          const parsed = createChannelParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} name and memberBotIds are required.`;
          }
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await studioChannelBus.create({
            name: parsed.data.name,
            memberBotIds: parsed.data.memberBotIds,
            actorId,
            createdByBotId: botId,
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            channelId: result.channel.id,
            name: result.channel.name,
            memberBotIds: result.channel.memberBotIds,
            uiChannelId: result.channel.channelId,
            note: "Post with studio_channel_message using channelId.",
          });
        },
      },
      {
        name: "studio_channel_message",
        ref: "studio/channel_message",
        description:
          "Post a message into a multi-bot studio channel. All members can list it via the channel inbox / GET API.",
        parameters: channelMessageParams,
        execute: async (args) => {
          if (!studioChannelBus) {
            return `${REFUSAL_MARKER} Studio channels are not wired in this deployment.`;
          }
          const parsed = channelMessageParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} channelId and message are required.`;
          }
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await studioChannelBus.post({
            studioChannelId: parsed.data.channelId,
            fromBotId: parsed.data.fromBotId?.trim() || botId,
            message: parsed.data.message,
            actorId,
          });
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({
            ok: true,
            messageId: result.message.id,
            channelId: result.channel.id,
            memberBotIds: result.channel.memberBotIds,
          });
        },
      },

      {
        name: "studio_message_bot",
        ref: "studio/message_bot",
        description:
          "Message another Studio bot (Grok SendToAgent parity). priority=true wakes them into their chat; priority=false is FYI (inbox/roster, no wake). Works with dynamic bots from studio_spawn_bot. Prefer this for cross-bot coordination that is not a full coding handoff envelope.",
        parameters: messageBotParams,
        execute: async (args) => {
          if (!botMessaging) {
            return `${REFUSAL_MARKER} Bot messaging is not wired in this deployment.`;
          }
          const parsed = messageBotParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} botId and message are required.`;
          }
          const actorId = messagingActorId ?? "dev-local-user";
          const result = await botMessaging.send({
            fromBotId: parsed.data.fromBotId?.trim() || botId,
            toBotId: parsed.data.botId.trim(),
            message: parsed.data.message,
            priority: parsed.data.priority,
            actorId,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            ok: true,
            messageId: result.message.id,
            toBotId: result.message.toBotId,
            priority: result.message.priority,
            woke: result.woke,
            channelId: result.message.channelId,
            threadId: result.message.threadId,
            note: result.woke
              ? "Priority message queued — recipient chat will show the ask."
              : "FYI stored in inbox and roster; recipient is not woken.",
          });
        },
      },

      {
        name: "studio_spawn_bot",
        ref: "studio/spawn_bot",
        description:
          "Create a custom Studio bot (Grok CreateAgent parity). Appears in the agents list with a Custom badge; chatable with the given systemPrompt. Phase 1 = chat/role only (not Cursor ownerBotId unless capabilities includes cursor_execute — Phase 1b). Prefer this over asking Abdullah to edit agents.yaml. Returns { botId, name, created: true }.",
        parameters: spawnBotParams,
        execute: async (args) => {
          const parsed = spawnBotParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} id and name are required (and systemPrompt or templateRoleId).`;
          }
          const result = await createDynamicBot(database, parsed.data);
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            botId: result.bot.id,
            name: result.bot.name,
            created: true,
            source: "dynamic",
            note: "Bot is chatable now. Phase 1: chat/role only unless cursor_execute capability was set (Phase 1b).",
          });
        },
      },

      {
        name: "studio_desktop_session",
        ref: "studio/desktop_session",
        description:
          "Drive the Mac GUI (not Cursor coding): open/focus an app, type/click/wait, capture screenshots under studio-local/ui-test/out/desktop/<stamp>/. Prefer TextEdit type (app scripting) when Accessibility is unavailable. Never escalates privileges; destructive OS actions are out of scope. One session at a time. Use start|action|stop|status.",
        parameters: desktopSessionParams,
        execute: async (args) => {
          const parsed = desktopSessionParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} action is required.`;
          }
          const { action } = parsed.data;
          if (action === "status") {
            return JSON.stringify({ session: getDesktopSession() });
          }
          if (action === "stop") {
            const result = await stopDesktopSession();
            return JSON.stringify({ ok: true, session: result.session });
          }
          const steps = (parsed.data.steps ?? []) as DesktopStep[];
          if (action === "start") {
            const result = await startDesktopSession({ app: parsed.data.app, steps });
            if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
            return JSON.stringify({
              ok: true,
              session: result.session,
              note: "Session stays open until studio_desktop_session stop. Screenshots under session.outDir.",
            });
          }
          const result = await runDesktopActions(steps);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, session: result.session });
        },
      },

      {
        name: "studio_browser_session",
        ref: "studio/browser_session",
        description:
          "Drive an unattended Chromium browser with a persistent profile under studio-local/browser-profile. start: navigate to url, optional steps, screenshots under studio-local/ui-test/out/browser/<stamp>/. stop: close the session. status: current/last session. Prefer this for web checks before asking for Mac GUI. One session at a time.",
        parameters: browserSessionParams,
        execute: async (args) => {
          const parsed = browserSessionParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} action is required (start needs url).`;
          }
          const { action } = parsed.data;
          if (action === "status") {
            return JSON.stringify({ session: getBrowserSession() });
          }
          if (action === "stop") {
            const result = await stopBrowserSession();
            return JSON.stringify({ ok: true, session: result.session });
          }
          if (!parsed.data.url) {
            return `${REFUSAL_MARKER} url is required to start a browser session.`;
          }
          const steps = (parsed.data.steps ?? []) as BrowserStep[];
          const result = await startBrowserSession({
            url: parsed.data.url,
            steps,
            headless: parsed.data.headless,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            ok: true,
            session: result.session,
            note: "Session stays open until studio_browser_session stop. Screenshots are under session.outDir.",
          });
        },
      },

      {
        name: "studio_verify_claim",
        ref: "studio/verify_claim",
        description:
          "Assign the Studio Verifier (Mac evidence only, no feature implement). Creates a studio_run_task owned by studio-verifier. Prefer this over asking Engineer to self-check. Poll studio_task_status; expect Verdict PASS|FAIL|BLOCKED with evidence.",
        parameters: verifyClaimParams,
        execute: async (args) => {
          const parsed = verifyClaimParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} title and claim are required.`;
          }
          const result = await dispatcher.submit({
            title: parsed.data.title,
            goal: parsed.data.claim,
            acceptanceCriteria: parsed.data.claim,
            idempotencyKey: parsed.data.idempotencyKey,
            ownerBotId: STUDIO_VERIFIER_BOT_ID,
            maestroFlow: parsed.data.maestroFlow,
            deviceUdid: parsed.data.deviceUdid,
            background: true,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            taskId: result.taskId,
            ownerBotId: STUDIO_VERIFIER_BOT_ID,
            deduplicated: result.deduplicated === true,
            note: "Verifier runs evidence-only on the Mac. Poll studio_task_status.",
          });
        },
      },

      {
        name: "studio_run_task",
        ref: "studio/run_task",
        description:
          "REQUIRED for local product work when AC is clear (P0.5 unattended): call in the SAME turn — create/edit files in the selected project, run changes, open a feature branch/draft PR, or (ownerBotId=quality-engineer) independently verify/QA. Uses cursor-agent on the Cursor subscription in a project worktree; after implementation the studio re-runs package.json typecheck+test and only then opens a draft PR. Do NOT clarify with menus, ask for dashboard Run Task, use host_list_folders/host_write_file, or ask about Engineer/git origin. Returns taskId; poll studio_task_status (includes checkAfter); then hand back Shipped/Evidence/Untested/Next. Do NOT call this for a question, a status lookup, or another bot asking you to summarize/retrieve something — use studio_inspect_product / studio_github_read / studio_task_status and answer in chat instead.",
        parameters: runTaskParams,
        execute: async (args) => {
          const parsed = runTaskParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} title and goal are required.`;
          }
          const ownerBotId = parsed.data.ownerBotId ?? "react-native-engineer";
          const result = await dispatcher.submit({
            title: parsed.data.title,
            goal: parsed.data.goal,
            acceptanceCriteria: parsed.data.acceptanceCriteria,
            idempotencyKey: parsed.data.idempotencyKey,
            ownerBotId,
            skipVerify: parsed.data.skipVerify,
            maestroFlow: parsed.data.maestroFlow,
            deviceUdid: parsed.data.deviceUdid,
            background: parsed.data.background,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            taskId: result.taskId,
            deduplicated: result.deduplicated === true,
            ownerBotId,
            background: result.background === true,
            kind: result.kind ?? null,
            backend: "cursor-agent (Cursor subscription)",
            note: "Work runs asynchronously in a project worktree. Poll studio_task_status. Do not ask the person for git origin or branch.",
          });
        },
      },
      {
        name: "studio_task_status",
        ref: "studio/task_status",
        description:
          "Read one Studio task's state, blocker, evidence (changed files, checkAfter verify results, worktreePath), and draft PR URL if any.",
        parameters: taskIdParams,
        execute: async (args) => {
          const parsed = taskIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} taskId is required.`;
          }
          const task = await taskStore.read(parsed.data.taskId);
          if (!task) {
            return `${REFUSAL_MARKER} No such task.`;
          }
          const [evidence] = await database
            .select()
            .from(studioEvidence)
            .where(eq(studioEvidence.taskId, parsed.data.taskId))
            .limit(1);
          const [pr] = await database
            .select()
            .from(studioPullRequests)
            .where(eq(studioPullRequests.taskId, parsed.data.taskId))
            .limit(1);
          return JSON.stringify({
            id: task.id,
            title: task.title,
            state: task.state,
            goal: task.goal,
            blockedReason: task.blockedReason,
            ownerBotId: task.ownerBotId,
            running: dispatcher.inFlight.has(task.id),
            evidence: evidence
              ? {
                  ok: evidence.ok,
                  changedFiles: evidence.changedFiles,
                  blocker: evidence.blocker,
                  backend: evidence.backend,
                  reportedModel: evidence.reportedModel,
                  checkAfter: evidence.checkAfter,
                  worktreePath: evidence.worktreePath,
                  maestro: evidence.maestro ?? null,
                }
              : null,
            pullRequest:
              pr?.number && pr.url
                ? {
                    url: pr.url,
                    number: pr.number,
                    draft: pr.draft,
                    headBranch: pr.headBranch,
                    baseBranch: pr.baseBranch,
                  }
                : null,
          });
        },
      },

      {
        name: "studio_inspect_product",
        ref: "studio/inspect_product",
        description:
          "READ-ONLY inventory of the selected product: *Screen files, navigator routes, typed routes. Use for questions like list our screens / what screens exist. Paste the returned text into chat as the answer. Do NOT call studio_run_task for read-only inventory.",
        parameters: z.object({}),
        execute: async () => {
          const inspected = await inspectSelectedProduct(database);
          if (!inspected.ok) {
            return `${REFUSAL_MARKER} ${inspected.error}`;
          }
          return formatProductInspectForChat(inspected.result);
        },
      },
      {
        name: "studio_github_read",
        ref: "studio/github_read",
        description:
          "READ-ONLY GitHub lookup for the selected product's repo: PR/issue status, repo info, or a file's content on any branch (e.g. a PR's head branch) — use file_view instead of a browser for this. Use to answer 'what's the status of PR #12' / 'list open issues' / 'is there a PR for this branch' / 'what does docs/X.md say on that PR's branch'. Paste the returned text into chat as the answer. Do NOT call studio_run_task for a lookup, and do NOT reach for studio_browser_session to read a repo file — this never creates, edits, or comments on anything.",
        parameters: z.object({
          query: z
            .enum(["pr_view", "pr_list", "issue_view", "issue_list", "repo_view", "file_view"])
            .describe(
              "pr_view/issue_view require number. pr_list/issue_list accept an optional limit. repo_view takes neither. file_view requires path and accepts an optional ref (branch/commit; defaults to the repo's default branch).",
            ),
          number: z.number().int().positive().optional().describe("PR or issue number, for pr_view/issue_view."),
          limit: z.number().int().positive().max(50).optional().describe("Max rows for pr_list/issue_list (default 10)."),
          path: z.string().min(1).optional().describe("Repo-relative file path, for file_view (e.g. docs/studio/MVP-READINESS.md)."),
          ref: z.string().min(1).optional().describe("Branch, tag, or commit SHA, for file_view (e.g. a PR's head branch). Defaults to the repo's default branch."),
        }),
        execute: async (args) => {
          const parsed = z
            .object({
              query: z.enum(["pr_view", "pr_list", "issue_view", "issue_list", "repo_view", "file_view"]),
              number: z.number().int().positive().optional(),
              limit: z.number().int().positive().max(50).optional(),
              path: z.string().min(1).optional(),
              ref: z.string().min(1).optional(),
            })
            .safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} query is required.`;
          }
          const { query, number, limit, path, ref } = parsed.data;
          if ((query === "pr_view" || query === "issue_view") && !number) {
            return `${REFUSAL_MARKER} number is required for ${query}.`;
          }
          if (query === "file_view" && !path) {
            return `${REFUSAL_MARKER} path is required for file_view.`;
          }

          const product = await getSelectedProduct(database);
          if (!product?.localPath) {
            return `${REFUSAL_MARKER} No product is selected. Register/select a project first.`;
          }
          const resolved = await resolveProjectPath(product.localPath);
          if (!resolved.ok) {
            return `${REFUSAL_MARKER} ${resolved.reason}`;
          }
          const cwd = resolved.absolutePath;
          const gh = ghRunner();
          const repo = await resolveRepository(cwd, gh);
          if (!repo.ok) {
            return `${REFUSAL_MARKER} ${repo.reason}`;
          }

          const rowLimit = String(limit ?? 10);
          const prFields = "number,title,url,state,isDraft,headRefName,baseRefName,updatedAt";
          const issueFields = "number,title,url,state,updatedAt";
          let result: { exitCode: number; stdout: string; stderr: string };
          switch (query) {
            case "pr_view":
              result = await gh(
                ["pr", "view", String(number), "--repo", repo.repository, "--json", `${prFields},body`],
                { cwd },
              );
              break;
            case "pr_list":
              result = await gh(
                ["pr", "list", "--repo", repo.repository, "--state", "all", "--limit", rowLimit, "--json", prFields],
                { cwd },
              );
              break;
            case "issue_view":
              result = await gh(
                ["issue", "view", String(number), "--repo", repo.repository, "--json", `${issueFields},body`],
                { cwd },
              );
              break;
            case "issue_list":
              result = await gh(
                ["issue", "list", "--repo", repo.repository, "--state", "all", "--limit", rowLimit, "--json", issueFields],
                { cwd },
              );
              break;
            case "repo_view":
              result = await gh(
                ["repo", "view", repo.repository, "--json", "nameWithOwner,description,url,defaultBranchRef,isPrivate"],
                { cwd },
              );
              break;
            case "file_view": {
              const apiPath = `repos/${repo.repository}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
              result = await gh(["api", apiPath], { cwd });
              break;
            }
          }
          if (result.exitCode !== 0) {
            return `${REFUSAL_MARKER} ${result.stderr.trim() || `gh ${query} failed.`}`;
          }
          if (query === "file_view") {
            try {
              const parsedFile = JSON.parse(result.stdout) as {
                content?: string;
                encoding?: string;
                type?: string;
                message?: string;
              };
              if (parsedFile.type && parsedFile.type !== "file") {
                return `${REFUSAL_MARKER} "${path}" is a ${parsedFile.type}, not a file.`;
              }
              if (!parsedFile.content || parsedFile.encoding !== "base64") {
                return `${REFUSAL_MARKER} ${parsedFile.message || `"${path}" has no readable content.`}`;
              }
              const decoded = Buffer.from(parsedFile.content, "base64").toString("utf8");
              const CAP = 20_000;
              return decoded.length > CAP
                ? `${decoded.slice(0, CAP)}\n\n[truncated — file is ${decoded.length} chars, showing first ${CAP}]`
                : decoded;
            } catch {
              return `${REFUSAL_MARKER} Could not parse the file response for "${path}".`;
            }
          }
          return result.stdout.trim() || "{}";
        },
      },
      {
        name: "studio_read_file",
        ref: "studio/read_file",
        description:
          "READ-ONLY: read one file's content from the selected product's local checkout (whatever branch is currently checked out there). Use for code, config, or docs already on disk (e.g. specs, existing implementations). For a file on a branch that isn't checked out locally (e.g. a PR's head branch), use studio_github_read with query: file_view instead. Paste the returned text into chat as the answer. Do NOT call studio_run_task to read a file.",
        parameters: z.object({
          path: z.string().min(1).describe("File path relative to the product's repo root, e.g. src/features/restore/restore.ts"),
        }),
        execute: async (args) => {
          const parsed = z.object({ path: z.string().min(1) }).safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} path is required.`;
          }
          const product = await getSelectedProduct(database);
          if (!product?.localPath) {
            return `${REFUSAL_MARKER} No product is selected. Register/select a project first.`;
          }
          const resolved = await resolveProjectPath(product.localPath);
          if (!resolved.ok) {
            return `${REFUSAL_MARKER} ${resolved.reason}`;
          }
          const root = resolved.absolutePath;
          const target = resolvePath(root, parsed.data.path);
          // Refuse anything that escapes the product root (e.g. `../../etc/passwd`).
          if (target !== root && !target.startsWith(`${root}/`)) {
            return `${REFUSAL_MARKER} "${parsed.data.path}" is outside the product's repo root.`;
          }
          const relPath = relative(root, target).replaceAll("\\", "/");
          let info;
          try {
            info = await stat(target);
          } catch {
            return `${REFUSAL_MARKER} No such file: ${relPath}`;
          }
          if (!info.isFile()) {
            return `${REFUSAL_MARKER} "${relPath}" is not a file.`;
          }
          const CAP_BYTES = 200_000;
          if (info.size > CAP_BYTES) {
            return `${REFUSAL_MARKER} "${relPath}" is ${info.size} bytes, too large to read here (cap ${CAP_BYTES}).`;
          }
          let content: string;
          try {
            content = await readFile(target, "utf8");
          } catch (error) {
            return `${REFUSAL_MARKER} Could not read "${relPath}" as text: ${error instanceof Error ? error.message : String(error)}`;
          }
          const CAP_CHARS = 20_000;
          return content.length > CAP_CHARS
            ? `${content.slice(0, CAP_CHARS)}\n\n[truncated — file is ${content.length} chars, showing first ${CAP_CHARS}]`
            : content;
        },
      },
      {
        name: "studio_web_fetch",
        ref: "studio/web_fetch",
        description:
          "READ-ONLY: fetch a web page or API URL and return its text content (HTML is stripped to readable text). Use to look up documentation, an external reference, or a URL the person pasted. It cannot search the web — it only fetches a URL you already have. Paste the returned text into chat as the answer, quoting only what's relevant.",
        parameters: z.object({
          url: z.string().url().describe("Full http(s) URL to fetch."),
        }),
        execute: async (args) => {
          const parsed = z.object({ url: z.string().url() }).safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} A valid url is required.`;
          }
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(parsed.data.url);
          } catch {
            return `${REFUSAL_MARKER} Invalid URL.`;
          }
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return `${REFUSAL_MARKER} Only http/https URLs are allowed.`;
          }
          const host = parsedUrl.hostname.toLowerCase();
          const isPrivateHost =
            host === "localhost" ||
            host === "0.0.0.0" ||
            host === "169.254.169.254" ||
            host.endsWith(".local") ||
            /^127\./.test(host) ||
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host);
          if (isPrivateHost) {
            return `${REFUSAL_MARKER} Refusing to fetch a private/internal address.`;
          }

          let response: Response;
          try {
            response = await fetch(parsedUrl, {
              redirect: "follow",
              signal: AbortSignal.timeout(15_000),
              headers: { "user-agent": "openbot-studio/1.0 (+read-only tool)" },
            });
          } catch (error) {
            return `${REFUSAL_MARKER} Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (!response.ok) {
            return `${REFUSAL_MARKER} ${response.status} ${response.statusText} fetching ${parsedUrl.href}`;
          }
          const contentType = response.headers.get("content-type") ?? "";
          const raw = await response.text();
          const CAP_CHARS = 20_000;
          let text = raw;
          if (contentType.includes("html")) {
            text = raw
              .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
              .replace(/<!--[\s\S]*?-->/g, " ")
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/[ \t]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }
          return text.length > CAP_CHARS
            ? `${text.slice(0, CAP_CHARS)}\n\n[truncated — content is ${text.length} chars, showing first ${CAP_CHARS}]`
            : text;
        },
      },
      {
        name: "studio_list_tasks",
        ref: "studio/list_tasks",
        description:
          "List recent Studio tasks for the selected product (id, title, state, running).",
        parameters: z.object({}),
        execute: async () => {
          const rows = await database
            .select({
              id: studioTasks.id,
              title: studioTasks.title,
              state: studioTasks.state,
              ownerBotId: studioTasks.ownerBotId,
              updatedAt: studioTasks.updatedAt,
            })
            .from(studioTasks)
            .where(eq(studioTasks.productId, STUDIO_PRODUCT_ID))
            .orderBy(desc(studioTasks.updatedAt))
            .limit(20);
          return JSON.stringify({
            tasks: rows.map((row) => ({
              ...row,
              running: dispatcher.inFlight.has(row.id),
            })),
          });
        },
      },
    ];

    return tools;
  };
}
