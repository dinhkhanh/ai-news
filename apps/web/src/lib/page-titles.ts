import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { projectLabel } from "@/lib/project-state";
import { getWorkspace } from "@/lib/workspace";

/**
 * Titles for `generateMetadata` on the dynamic pages: one light query in the
 * active workspace, null when signed out, missing or unreadable (the page
 * itself redirects or 404s, so the tab falls back to the section name).
 */
export async function projectTitle(id: string): Promise<string | null> {
  try {
    const ws = await getWorkspace();
    if (!ws) return null;
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ columns: { title: true, url: true }, where: eq(schema.projects.id, id) }));
    return project ? projectLabel(project) : null;
  } catch {
    return null;
  }
}

/** `comics.title` follows the current version's doc title (lib/comic/service.ts), so the row is enough. */
export async function comicTitle(id: string): Promise<string | null> {
  try {
    const ws = await getWorkspace();
    if (!ws) return null;
    const comic = await withOrgContext(ws, (tx) =>
      tx.query.comics.findFirst({ columns: { title: true }, where: and(eq(schema.comics.id, id), eq(schema.comics.organizationId, ws.organizationId)) }),
    );
    return comic ? (comic.title ?? "Truyện chưa có tên") : null;
  } catch {
    return null;
  }
}
