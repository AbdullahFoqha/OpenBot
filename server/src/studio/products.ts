/**
 * Multi-product registry: absolute git roots the studio can run tasks against.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioProducts } from "../db/schema";
import { resolveProjectPath, STUDIO_PRODUCT_ID } from "./project-path";

export type StudioProductRow = {
  id: string;
  name: string;
  localPath: string | null;
  isSelected: boolean;
  queuePaused: boolean;
  retiredAt: Date | null;
};

function slugifyPath(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "project";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

export async function listProducts(database: Database): Promise<StudioProductRow[]> {
  const rows = await database
    .select({
      id: studioProducts.id,
      name: studioProducts.name,
      localPath: studioProducts.localPath,
      isSelected: studioProducts.isSelected,
      queuePaused: studioProducts.queuePaused,
      retiredAt: studioProducts.retiredAt,
    })
    .from(studioProducts)
    .where(isNull(studioProducts.retiredAt));
  return rows;
}

export async function getSelectedProduct(
  database: Database,
): Promise<StudioProductRow | null> {
  const [selected] = await database
    .select({
      id: studioProducts.id,
      name: studioProducts.name,
      localPath: studioProducts.localPath,
      isSelected: studioProducts.isSelected,
      queuePaused: studioProducts.queuePaused,
      retiredAt: studioProducts.retiredAt,
    })
    .from(studioProducts)
    .where(and(eq(studioProducts.isSelected, true), isNull(studioProducts.retiredAt)))
    .limit(1);
  if (selected) return selected;

  // Compat: fall back to legacy studio-local row
  const [legacy] = await database
    .select({
      id: studioProducts.id,
      name: studioProducts.name,
      localPath: studioProducts.localPath,
      isSelected: studioProducts.isSelected,
      queuePaused: studioProducts.queuePaused,
      retiredAt: studioProducts.retiredAt,
    })
    .from(studioProducts)
    .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
    .limit(1);
  return legacy ?? null;
}

export async function selectProduct(
  database: Database,
  id: string,
): Promise<{ ok: true; product: StudioProductRow } | { ok: false; error: string; status: 404 }> {
  const [row] = await database
    .select({
      id: studioProducts.id,
      name: studioProducts.name,
      localPath: studioProducts.localPath,
      isSelected: studioProducts.isSelected,
      queuePaused: studioProducts.queuePaused,
      retiredAt: studioProducts.retiredAt,
    })
    .from(studioProducts)
    .where(and(eq(studioProducts.id, id), isNull(studioProducts.retiredAt)))
    .limit(1);
  if (!row) return { ok: false, error: `No such product: ${id}`, status: 404 };

  await database.transaction(async (tx) => {
    await tx
      .update(studioProducts)
      .set({ isSelected: false })
      .where(isNull(studioProducts.retiredAt));
    await tx
      .update(studioProducts)
      .set({ isSelected: true })
      .where(eq(studioProducts.id, id));
  });

  return {
    ok: true,
    product: { ...row, isSelected: true },
  };
}

export async function registerProduct(
  database: Database,
  input: { path: string; name?: string; id?: string; select?: boolean },
): Promise<
  | { ok: true; product: StudioProductRow; created: boolean }
  | { ok: false; error: string; status: 400 | 409 }
> {
  const resolved = await resolveProjectPath(input.path.trim());
  if (!resolved.ok) return { ok: false, error: resolved.reason, status: 400 };

  // Reuse existing row with same absolute path
  const existing = await listProducts(database);
  const samePath = existing.find((p) => p.localPath === resolved.absolutePath);
  if (samePath) {
    if (input.select !== false) {
      await selectProduct(database, samePath.id);
    }
    const [fresh] = await database
      .select({
        id: studioProducts.id,
        name: studioProducts.name,
        localPath: studioProducts.localPath,
        isSelected: studioProducts.isSelected,
        queuePaused: studioProducts.queuePaused,
        retiredAt: studioProducts.retiredAt,
      })
      .from(studioProducts)
      .where(eq(studioProducts.id, samePath.id))
      .limit(1);
    return { ok: true, product: fresh!, created: false };
  }

  let id = (input.id?.trim() || `product-${slugifyPath(resolved.gitRoot)}`).slice(0, 64);
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    return { ok: false, error: "id must be kebab-case slug.", status: 400 };
  }
  const [idClash] = await database
    .select({ id: studioProducts.id })
    .from(studioProducts)
    .where(eq(studioProducts.id, id))
    .limit(1);
  if (idClash) {
    id = `${id}-${Date.now().toString(36).slice(-4)}`;
  }

  const name =
    (input.name?.trim() ||
      resolved.gitRoot.split("/").filter(Boolean).pop() ||
      id).slice(0, 120);

  const shouldSelect = input.select !== false;
  await database.transaction(async (tx) => {
    if (shouldSelect) {
      await tx
        .update(studioProducts)
        .set({ isSelected: false })
        .where(isNull(studioProducts.retiredAt));
    }
    await tx.insert(studioProducts).values({
      id,
      name,
      localPath: resolved.absolutePath,
      isSelected: shouldSelect,
      queuePaused: false,
    });
  });

  const [row] = await database
    .select({
      id: studioProducts.id,
      name: studioProducts.name,
      localPath: studioProducts.localPath,
      isSelected: studioProducts.isSelected,
      queuePaused: studioProducts.queuePaused,
      retiredAt: studioProducts.retiredAt,
    })
    .from(studioProducts)
    .where(eq(studioProducts.id, id))
    .limit(1);
  return { ok: true, product: row!, created: true };
}
