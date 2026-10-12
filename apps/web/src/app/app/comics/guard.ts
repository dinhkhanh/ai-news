import "server-only";
import { notFound } from "next/navigation";
import { flagEnabled } from "@/lib/flags";
import { requireWorkspace } from "@/lib/workspace";

/** Every comic page: a signed-in member of a workspace, and the `comics` flag on (otherwise the section does not exist). */
export async function requireComicsWorkspace() {
  const ws = await requireWorkspace();
  if (!(await flagEnabled("comics"))) notFound();
  return ws;
}
