import { deleteProjectChain, getDeletionContext, resultResponse } from "@/lib/deletion/chain";

// Supprime un chantier : dépenses, planning, rapports... et factures non
// payées. Les factures payées sont gardées dans « Factures archivées ».
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deletion = await getDeletionContext();
  if ("response" in deletion) return deletion.response;
  return resultResponse(await deleteProjectChain(deletion.ctx, id));
}
