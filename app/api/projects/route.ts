import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createOrSyncProjectFromEstimate } from "@/lib/projects/create-project-from-estimate";

// Création d'un chantier, depuis la page Chantiers (bouton "+ Ajouter un
// chantier"), de deux façons possibles :
// - "automatique" : on donne un devis déjà fait ({estimateId}). Les prix ne
//   sont pas utilisés pour le planning : seuls les travaux à réaliser sont
//   extraits pour construire la liste de tâches et le pourcentage
//   d'avancement (le bordereau de prix est copié à part, pour la fiche du
//   chantier, sans lien avec ce planning).
// - "manuel" ({mode: "manual", name, location, tasks}) : le chantier est créé
//   directement avec la liste de travaux saisie à la main, sans aucun devis.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    estimateId?: string;
    mode?: string;
    name?: string;
    location?: string;
    tasks?: string[];
    price_lines?: Array<{ category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number; unit_price?: number }>;
    contract_amount?: number | string | null;
    margin_kind?: string;
    margin_value?: number | string | null;
  };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  // Diagnostic temporaire : vérifie ce que la base de données voit vraiment
  // comme utilisateur connecté au moment de la requête (auth.uid()), ET si
  // elle considère cet utilisateur comme admin de son organisation
  // (is_organization_admin), exactement au moment où l'insertion va être
  // tentée. Nécessite la fonction SQL temporaire public.whoami(p_org_id),
  // mise à jour pour accepter l'identifiant de l'organisation.
  const whoAmI = await supabase.rpc("whoami", { p_org_id: member.organization_id }).then(
    (result) => result,
    (error) => ({ data: null, error }),
  );
  console.log("[diag] whoami", { appUserId: user.id, dbSees: whoAmI.data, rpcError: whoAmI.error });

  if (body.mode === "manual") {
    const name = (body.name || "").trim();
    if (!name) return NextResponse.json({ error: "Le nom du chantier est obligatoire." }, { status: 400 });

    // On choisit nous-mêmes l'identifiant du chantier avant de l'enregistrer,
    // au lieu de demander à la base de nous le redonner juste après (via
    // .select().single()). En effet, juste après la création, la base doit
    // aussi vérifier qu'on peut "relire" cette toute nouvelle ligne — une
    // vérification distincte de celle qui autorise la création elle-même —
    // et c'était cette relecture immédiate qui bloquait, même quand la
    // création en elle-même était bien autorisée. Comme on connaît déjà
    // l'identifiant à l'avance, on n'a plus besoin de cette relecture.
    const projectId = randomUUID();
    const { error: createError } = await supabase
      .from("projects")
      .insert({
        id: projectId,
        organization_id: member.organization_id,
        name,
        location: (body.location || "").trim() || null,
        status: "planned",
      });
    if (createError) {
      // Diagnostic temporaire : affiche le détail complet de l'erreur dans le
      // terminal du serveur (code/details/hint Postgres), en plus du message,
      // pour comprendre précisément pourquoi la sécurité de la base bloque la
      // création alors que le compte est bien "owner".
      console.error("[create project] insert failed", {
        userId: user.id,
        organizationId: member.organization_id,
        error: createError,
      });
      return NextResponse.json({
        error: createError.message,
        code: (createError as { code?: string }).code,
        details: (createError as { details?: string }).details,
        hint: (createError as { hint?: string }).hint,
        diagAppUserId: user.id,
        diagDbSees: whoAmI.data,
        diagRpcError: whoAmI.error ? String((whoAmI.error as { message?: string }).message ?? whoAmI.error) : null,
      }, { status: 400 });
    }

    // dao_sequence sert uniquement à figer l'ordre de la liste (celui saisi à
    // la main, ou celui déjà organisé par l'extraction du PDF) : sans lui,
    // l'ordre affiché pourrait changer après une mise à jour, alors que ce
    // classement sert de base au suivi d'avancement et aux rapports.
    const taskTitles = (body.tasks ?? []).map((title) => title.trim()).filter(Boolean);
    if (taskTitles.length > 0) {
      const { error: tasksError } = await supabase.from("project_tasks").insert(
        taskTitles.map((title, index) => ({
          organization_id: member.organization_id,
          project_id: projectId,
          title,
          dao_sequence: index + 1,
          is_dao_task: false,
        })),
      );
      if (tasksError) return NextResponse.json({ error: tasksError.message }, { status: 400 });
    }

    // Prix lus dans le devis PDF : copiés dans le bordereau du chantier (prix
    // client). Ils servent au montant certifié et à la facturation.
    let warning: string | undefined;
    const priceLines = (body.price_lines ?? []).filter((line) => String(line.designation ?? "").trim() && Number(line.unit_price) > 0);
    if (priceLines.length > 0) {
      // created_at croissant d'une milliseconde par ligne : garde l'ordre du
      // devis (catégories et lignes) quand on relit le bordereau.
      const baseTime = Date.now();
      const rows = priceLines.map((line, index) => {
        const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
        const unitPrice = Number(line.unit_price);
        return {
          organization_id: member.organization_id,
          project_id: projectId,
          position: String(index + 1),
          designation: String(line.designation).trim(),
          unit: String(line.unit ?? "").trim() || null,
          quantity,
          unit_price: null,
          external_unit_price: unitPrice,
          total: Math.round(quantity * unitPrice * 100) / 100,
          is_internal: false,
          created_at: new Date(baseTime + index).toISOString(),
          category: String(line.category ?? "").trim() || null,
          subcategory: String(line.subcategory ?? "").trim() || null,
        };
      });
      let { error: itemsError } = await supabase.from("project_price_items").insert(rows);
      if (itemsError && /category|subcategory/.test(itemsError.message)) {
        // Fichier SQL des titres pas encore exécuté : on enregistre sans eux.
        ({ error: itemsError } = await supabase.from("project_price_items").insert(rows.map(({ category: _c, subcategory: _s, ...rest }) => rest)));
      }
      if (itemsError) warning = `Chantier créé, mais les prix du devis n'ont pas pu être enregistrés : ${itemsError.message}`;
    } else {
      // Pas de prix dans le devis : prix de l'offre et/ou marge attendue
      // donnés à la main (facultatifs).
      const parse = (value: unknown) => {
        const text = String(value ?? "").replace(/\s/g, "").replace(",", ".");
        if (text === "") return null;
        const n = Number(text);
        return Number.isFinite(n) ? n : null;
      };
      const contract = parse(body.contract_amount);
      // Prix et marge sont exclusifs : si les deux arrivent, le prix fixe gagne.
      const marginValue = contract !== null && contract > 0 ? null : parse(body.margin_value);
      if ((contract !== null && contract > 0) || marginValue !== null) {
        const { error: settingsError } = await supabase.from("projects").update({
          contract_amount: contract !== null && contract > 0 ? contract : null,
          expected_margin_percent: marginValue !== null && body.margin_kind !== "amount" ? marginValue : null,
          expected_margin_amount: marginValue !== null && body.margin_kind === "amount" ? marginValue : null,
        }).eq("id", projectId);
        if (settingsError) warning = "Chantier créé, mais le prix et la marge n'ont pas pu être enregistrés (le fichier SQL « 20261006_project_pricing.sql » doit d'abord être exécuté dans Supabase). Tu pourras les saisir ensuite dans Factures & paiements.";
      }
    }

    return NextResponse.json({ ok: true, projectId, warning });
  }

  const estimateId = body.estimateId;
  if (!estimateId) return NextResponse.json({ error: "Devis manquant." }, { status: 400 });

  const result = await createOrSyncProjectFromEstimate(supabase, {
    organizationId: member.organization_id,
    estimateId,
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, projectId: result.projectId });
}
