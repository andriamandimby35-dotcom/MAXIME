import { deleteTenderChain, getDeletionContext, resultResponse } from "@/lib/deletion/chain";

// Supprime un DAO ET, en chaîne, ses devis et ses chantiers (avec leurs
// dépenses et factures non payées ; les factures payées sont gardées dans
// « Factures archivées »).
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deletion = await getDeletionContext();
  if ("response" in deletion) return deletion.response;
  return resultResponse(await deleteTenderChain(deletion.ctx, id));
}
