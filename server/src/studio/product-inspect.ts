/**
 * Read-only product inventory for Studio Lead chat (screens / routes / screen files).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Database } from "../db/client";
import { getSelectedProduct } from "./products";
import { resolveProjectPath } from "./project-path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".expo",
  "ios",
  "android",
  "coverage",
  ".next",
]);

export type ProductInspectResult = {
  productId: string;
  productName: string;
  projectPath: string;
  screenFiles: Array<{ path: string; name: string }>;
  navigatorRoutes: string[];
  typedRoutes: string[];
  notes: string[];
};

async function walkTsFiles(root: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walkTsFiles(full, out, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!/\.(tsx|ts|jsx|js)$/.test(ent.name)) continue;
    out.push(full);
  }
}

function screenNameFromPath(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.(tsx|ts|jsx|js)$/, "");
}

function extractRouteNames(source: string): string[] {
  const names = new Set<string>();
  const re = /<(?:Stack|Tabs|Drawer)\.Screen\b[^>]*\bname=(["'])([^"']+)\1/g;
  for (const m of source.matchAll(re)) {
    names.add(m[2]!);
  }
  return [...names].sort();
}

function extractTypedRoutes(source: string): string[] {
  const names = new Set<string>();
  const bodies = source.match(/export\s+type\s+\w*ParamList\s*=\s*\{([\s\S]*?)\};/g) ?? [];
  for (const block of bodies) {
    for (const m of block.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/gm)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

export async function inspectSelectedProduct(
  database: Database,
): Promise<{ ok: true; result: ProductInspectResult } | { ok: false; error: string }> {
  const product = await getSelectedProduct(database);
  if (!product?.localPath) {
    return { ok: false, error: "No product is selected. Register/select a project first." };
  }
  const resolved = await resolveProjectPath(product.localPath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason };
  }
  const root = resolved.absolutePath;
  const files: string[] = [];
  await walkTsFiles(root, files);

  const screenFiles = files
    .filter((f) => (/Screen\.(tsx|ts|jsx|js)$/.test(f) || /\/screens\//i.test(f)) && !/\/design-system\/Screen\./.test(f))
    .map((f) => {
      const path = relative(root, f).replaceAll("\\", "/");
      return { path, name: screenNameFromPath(path) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const navigatorRoutes = new Set<string>();
  const typedRoutes = new Set<string>();
  const notes: string[] = [];

  for (const f of files) {
    const rel = relative(root, f).replaceAll("\\", "/");
    if (!/navigation|navigator|router/i.test(rel)) continue;
    let src = "";
    try {
      src = await readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const n of extractRouteNames(src)) navigatorRoutes.add(n);
    for (const n of extractTypedRoutes(src)) typedRoutes.add(n);
  }

  if (screenFiles.length === 0) {
    notes.push("No *Screen.* files found under the selected product (excluding node_modules).");
  }
  if (navigatorRoutes.size === 0) {
    notes.push("No React Navigation Stack/Tabs/Drawer Screen names found.");
  }

  return {
    ok: true,
    result: {
      productId: product.id,
      productName: product.name,
      projectPath: root,
      screenFiles,
      navigatorRoutes: [...navigatorRoutes].sort(),
      typedRoutes: [...typedRoutes].sort(),
      notes,
    },
  };
}

export function formatProductInspectForChat(result: ProductInspectResult): string {
  const lines: string[] = [];
  lines.push(`Product: ${result.productName} (${result.productId})`);
  lines.push(`Path: ${result.projectPath}`);
  lines.push("");
  lines.push("Screens (files):");
  if (result.screenFiles.length === 0) {
    lines.push("- (none found)");
  } else {
    for (const s of result.screenFiles) {
      lines.push(`- ${s.name} — \`${s.path}\``);
    }
  }
  if (result.navigatorRoutes.length) {
    lines.push("");
    lines.push("Navigator routes:");
    for (const r of result.navigatorRoutes) lines.push(`- ${r}`);
  }
  if (result.typedRoutes.length) {
    lines.push("");
    lines.push("Typed route params:");
    for (const r of result.typedRoutes) lines.push(`- ${r}`);
  }
  if (result.notes.length) {
    lines.push("");
    lines.push("Notes:");
    for (const n of result.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push(
    "Instruction to Lead: paste this inventory into chat as plain markdown. Do not hide it behind a task or artifact id.",
  );
  return lines.join("\n");
}
