/**
 * P2.3 — Studio-facing MCP connector install/auth UX (Grok AddMcpServer / AuthenticateMcpServer parity).
 * Catalogue installs only (pinned hosts). Custom URLs stay on the admin Plugins path.
 */
import { CATALOGUE, catalogueEntry } from "../plugins/catalogue";
import {
  authorizationUrlFor,
  challengeFor,
  createVerifier,
  redirectUriFor,
  sealConnectState,
} from "../plugins/oauth";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  type PluginStore,
} from "../plugins/store";

export type StudioMcpConnectConfig = {
  publicUrl: string | null | undefined;
  encryptionKey: string;
};

export type StudioMcpBus = {
  catalogue: (actorId: string) => Promise<{
    connectors: Array<{
      key: string;
      title: string;
      vendor: string;
      summary: string;
      docsUrl: string;
      auth: string;
      installed: boolean;
      connected: boolean;
      authStatus: "ready" | "needs_install" | "needs_auth" | "needs_public_url" | "error";
      lastError: string | null;
    }>;
    redirectUri: string | null;
  }>;
  install: (input: {
    key: string;
    by: string;
    instanceHost?: string;
  }) => Promise<
    | { ok: true; server: { id: string; title: string; vendor: string; url: string } }
    | { ok: false; error: string; status: 400 }
  >;
  status: (actorId: string, serverId?: string) => Promise<{
    servers: Array<{
      id: string;
      title: string;
      auth: string;
      installed: true;
      connected: boolean;
      authStatus: string;
      lastError: string | null;
      tools: number;
    }>;
  }>;
  connectStart: (input: {
    serverId: string;
    userId: string;
    by: string;
  }) => Promise<
    | { ok: true; authorizationUrl: string; serverId: string }
    | { ok: false; error: string; status: 400 | 409 | 503 }
  >;
};

type AuthStatus = "ready" | "needs_install" | "needs_auth" | "needs_public_url" | "error";

function authStatusFor(input: {
  authKind: string;
  installed: boolean;
  connected: boolean;
  lastError: string | null;
  publicUrl: string | null;
}): AuthStatus {
  if (input.lastError) return "error";
  if (!input.installed) return "needs_install";
  if (input.authKind === "none" || input.authKind === "builtin" || input.authKind === "deployment-bearer") {
    return "ready";
  }
  if (input.authKind === "user-oauth") {
    if (input.connected) return "ready";
    if (!input.publicUrl) return "needs_public_url";
    return "needs_auth";
  }
  return "needs_auth";
}

export function createStudioMcpBus(options: {
  pluginStore: PluginStore;
  connect: StudioMcpConnectConfig;
}): StudioMcpBus {
  const { pluginStore, connect } = options;
  const publicUrl = connect.publicUrl?.trim() || null;

  return {
    async catalogue(actorId) {
      const [servers, connections] = await Promise.all([
        pluginStore.listServers(),
        pluginStore.connectionsFor(actorId),
      ]);
      const installed = new Map(servers.map((s) => [s.id, s]));
      const connectedIds = new Set(connections.map((c) => c.serverId));

      return {
        connectors: CATALOGUE.map((entry) => {
          const server = installed.get(entry.key);
          const installedFlag = Boolean(server);
          const connected = connectedIds.has(entry.key);
          return {
            key: entry.key,
            title: entry.title,
            vendor: entry.vendor,
            summary: entry.summary,
            docsUrl: entry.docsUrl,
            auth: entry.auth.kind,
            installed: installedFlag,
            connected,
            authStatus: authStatusFor({
              authKind: entry.auth.kind,
              installed: installedFlag,
              connected,
              lastError: server?.lastError ?? null,
              publicUrl,
            }),
            lastError: server?.lastError ?? null,
          };
        }),
        redirectUri: publicUrl ? redirectUriFor(publicUrl) : null,
      };
    },

    async install(input) {
      try {
        const server = await pluginStore.addServer({
          key: input.key,
          instanceHost: input.instanceHost,
          by: input.by,
        });
        return {
          ok: true,
          server: {
            id: server.id,
            title: server.title,
            vendor: server.vendor,
            url: server.url,
          },
        };
      } catch (err) {
        if (
          err instanceof CatalogueEntryUnknownError ||
          err instanceof CustomServerRefusedError
        ) {
          return { ok: false, error: err.message, status: 400 };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: 400,
        };
      }
    },

    async status(actorId, serverId) {
      const [servers, connections] = await Promise.all([
        pluginStore.listServers(),
        pluginStore.connectionsFor(actorId),
      ]);
      const connectedIds = new Set(connections.map((c) => c.serverId));
      const rows = servers
        .filter((s) => !serverId || s.id === serverId)
        .map((s) => {
          const entry = catalogueEntry(s.id);
          const authKind = entry?.auth.kind ?? "unknown";
          const connected = connectedIds.has(s.id);
          return {
            id: s.id,
            title: s.title,
            auth: authKind,
            installed: true as const,
            connected,
            authStatus: authStatusFor({
              authKind,
              installed: true,
              connected,
              lastError: s.lastError,
              publicUrl,
            }),
            lastError: s.lastError,
            tools: Array.isArray(s.tools) ? s.tools.length : 0,
          };
        });
      return { servers: rows };
    },

    async connectStart(input) {
      const entry = catalogueEntry(input.serverId);
      if (!entry) {
        return { ok: false, status: 400, error: `${input.serverId} is not in the MCP catalogue.` };
      }
      if (entry.auth.kind !== "user-oauth") {
        return {
          ok: false,
          status: 400,
          error: `${entry.title} does not use per-person OAuth (${entry.auth.kind}). Install is enough; no connect step.`,
        };
      }

      const installed = (await pluginStore.listServers()).some((s) => s.id === input.serverId);
      if (!installed) {
        return {
          ok: false,
          status: 409,
          error: `${entry.title} has not been added to this deployment yet. Install it first (studio_mcp_install).`,
        };
      }

      if (!publicUrl) {
        return {
          ok: false,
          status: 503,
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
        };
      }

      let client;
      try {
        client =
          (await pluginStore.oauthClientFor(input.serverId)) ??
          (entry.auth.clientRegistration === "dynamic"
            ? await pluginStore.ensureOAuthClient(input.serverId, input.by)
            : null);
      } catch (err) {
        if (err instanceof CatalogueEntryUnknownError) {
          return {
            ok: false,
            status: 409,
            error: `${entry.title} has not been added to this deployment yet. Install it first (studio_mcp_install).`,
          };
        }
        return {
          ok: false,
          status: 400,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!client) {
        return {
          ok: false,
          status: 409,
          error:
            entry.auth.clientRegistration === "dynamic"
              ? `${entry.title} would not register this deployment. Try again later.`
              : `${entry.title} has no OAuth client registered yet. An administrator must add one.`,
        };
      }

      const verifier = createVerifier();
      const authorizationUrl = authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(publicUrl),
        state: await sealConnectState(
          {
            userId: input.userId,
            serverId: input.serverId,
            verifier,
            returnTo: "settings",
          },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      });
      return { ok: true, authorizationUrl, serverId: input.serverId };
    },
  };
}
