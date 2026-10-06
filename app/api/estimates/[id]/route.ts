import { deleteEstimateChain, getDeletionContext, resultResponse } from "@/lib/deletion/chain";

// Supprime un devis ET, en chaîne, les chantiers créés à partir de lui
// (avec leurs dépenses et factures non payées ; les factures payées sont
// gardées dans « Factures archivées »). Fait avec le client admin car les
// politiques RLS n'autorisent pas le DELETE direct sur les devis.
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deletion = await getDeletionContext();
  if ("response" in deletion) return deletion.response;
  return resultResponse(await deleteEstimateChain(deletion.ctx, id));
}
