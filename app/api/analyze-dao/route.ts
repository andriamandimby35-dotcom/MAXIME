import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

// Un DAO peut contenir de nombreuses pages et des tableaux visuels détaillés.
// La route ne doit pas être interrompue pendant cette lecture complète.
// 300 secondes est la limite maximale autorisée par Vercel sur l'offre
// gratuite (Hobby) : une valeur plus haute (comme 900) fait échouer tout le
// déploiement, pas seulement cette fonction.
export const maxDuration = 300;

const daoSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    execution_period_days: { type: ["number", "null"] },
    execution_plan: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, duration_days: { type: ["number", "null"] }, sequence: { type: "number" }, source_reference: { type: "string" } }, required: ["title", "duration_days", "sequence", "source_reference"] } },
    site_execution_details: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, predecessor: { type: "string" }, personnel: { type: "string" }, materials_or_equipment: { type: "string" }, control_point: { type: "string" } }, required: ["title", "predecessor", "personnel", "materials_or_equipment", "control_point"] } },
    worksite_location: { type: "string" },
    worksite_location_source: { type: "string" },
    pricing_rules: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, formula: { type: "string" }, applicable_to: { type: "string" }, source_reference: { type: "string" } }, required: ["title", "formula", "applicable_to", "source_reference"] } },
    transport_weight_table: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        total_label: { type: "string" },
        total_weight: { type: "string" },
        source_reference: { type: "string" },
      },
      required: ["title", "columns", "rows", "total_label", "total_weight", "source_reference"],
    },
    plan_register: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        total_label: { type: "string" },
        total_count: { type: "string" },
        source_reference: { type: "string" },
        page_numbers: { type: "array", items: { type: "number" } },
      },
      required: ["title", "columns", "rows", "total_label", "total_count", "source_reference", "page_numbers"],
    },
    bdqe_layout: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_reference: { type: "string" },
        annotations: { type: "array", items: { type: "string" } },
        detail_table: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, columns: { type: "array", items: { type: "string" } }, total_label: { type: "string" }, source_reference: { type: "string" } }, required: ["title", "columns", "total_label", "source_reference"] },
        recap_tables: { type: "array", items: { type: "object", additionalProperties: false, properties: { reference: { type: "string" }, title: { type: "string" }, columns: { type: "array", items: { type: "string" } }, row_titles: { type: "array", items: { type: "string" } }, total_label: { type: "string" }, source_reference: { type: "string" } }, required: ["reference", "title", "columns", "row_titles", "total_label", "source_reference"] } },
      },
      required: ["source_reference", "annotations", "detail_table", "recap_tables"],
    },
    environmental_restrictions: { type: "array", items: { type: "object", additionalProperties: false, properties: { material: { type: "string" }, restriction: { type: "string" }, suggested_equivalent: { type: "string" }, source_reference: { type: "string" } }, required: ["material", "restriction", "suggested_equivalent", "source_reference"] } },
    work_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          row_type: { type: "string", enum: ["section", "item", "subtotal"] },
          parent_title: { type: "string" },
          parent_reference: { type: "string" },
          section_title: { type: "string" },
          designation: { type: "string" },
          category: { type: "string" },
          unit: { type: "string" },
          quantity: { type: ["number", "null"] },
          source_reference: { type: "string" },
          needs_review: { type: "boolean" },
          note: { type: "string" },
          pricing_context: { type: "string" },
        },
        required: [
          "row_type", "parent_title", "parent_reference", "section_title",
          "designation", "category", "unit", "quantity",
          "source_reference", "needs_review", "note", "pricing_context",
        ],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    internal_cost_recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["labor", "material", "equipment", "service", "overhead"] },
          title: { type: "string" },
          designation: { type: "string" },
          unit: { type: "string" },
          quantity: { type: ["number", "null"] },
          reason: { type: "string" },
          source_basis: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          default_option: { type: "string" },
          requires_validation: { type: "boolean" },
          safety_note: { type: "string" },
        },
        required: [
          "kind", "title", "designation", "unit", "quantity", "reason",
          "source_basis", "options", "default_option", "requires_validation", "safety_note",
        ],
      },
    },
    // Article, clause ou sommaire du DAO qui énumère la LISTE COMPLÈTE des
    // pièces à fournir pour la soumission (souvent intitulé "Dossier d'Appel
    // d'Offres", "Composition du dossier de soumission" ou équivalent) :
    // reproduit cette énumération telle quelle et dans son ordre exact, pour
    // que l'application puisse afficher les pièces détectées (submission_items)
    // dans le MÊME ORDRE que le DAO lui-même — utile uniquement pour l'ordre
    // d'affichage, jamais pour le contenu ou les modèles des pièces.
    submission_checklist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          sequence: { type: "number" },
          source_reference: { type: "string" },
          level: { type: "number" },
        },
        required: ["title", "sequence", "source_reference", "level"],
      },
    },
    submission_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["document_to_provide", "form_to_complete"] },
          title: { type: "string" },
          source_reference: { type: "string" },
          instructions: { type: "string" },
          required: { type: "boolean" },
          prefilled_values: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { key: { type: "string" }, value: { type: "string" } },
              required: ["key", "value"],
            },
          },
          template_origin: { type: "string", enum: ["dao", "internet", "generated", "none"] },
          template_source_url: { type: "string" },
          template_text: { type: "string" },
          template_page_numbers: { type: "array", items: { type: "number" } },
          template_fill_positions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { page: { type: "number" }, field_key: { type: "string" }, x_percent: { type: "number" }, y_percent: { type: "number" }, width_percent: { type: "number" } },
              required: ["page", "field_key", "x_percent", "y_percent", "width_percent"],
            },
          },
          template_tables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                columns: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                organization_column_indexes: { type: "array", items: { type: "number" } },
                // true : le DAO ne montre qu'une seule ligne d'exemple par
                // rubrique alors que le nombre réel d'entrées dépend du
                // candidat (litiges, conventions non exécutées, marchés
                // similaires...) — l'application dupliquera cette ligne
                // autant de fois que nécessaire. false : le tableau a un
                // nombre de lignes et colonnes toujours identique (ex. un
                // chiffre d'affaires réparti sur des colonnes d'années
                // précises déjà indiquées par le DAO).
                repeatable: { type: "boolean" },
              },
              required: ["title", "columns", "rows", "organization_column_indexes", "repeatable"],
            },
          },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                required: { type: "boolean" },
                description: { type: "string" },
              },
              required: ["key", "label", "required", "description"],
            },
          },
        },
        required: ["kind", "title", "source_reference", "instructions", "required", "prefilled_values", "template_origin", "template_source_url", "template_text", "template_page_numbers", "template_fill_positions", "template_tables", "fields"],
      },
    },
  },
  required: ["summary", "execution_period_days", "execution_plan", "site_execution_details", "worksite_location", "worksite_location_source", "pricing_rules", "transport_weight_table", "plan_register", "bdqe_layout", "environmental_restrictions", "work_items", "warnings", "internal_cost_recommendations", "submission_checklist", "submission_items"],
} as const;

function extractResponseText(payload: {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}) {
  if (payload.output_text) return payload.output_text;
  return payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("") || "";
}

function parseStructuredResponse(outputText: string) {
  const clean = outputText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  const candidates = [clean];
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(clean.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // La réponse peut exceptionnellement être entourée de texte technique.
    }
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

    const { data: member } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (!member?.organization_id) {
      return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as { tenderId?: string; pdfUrl?: string } | null;
    const tenderId = body?.tenderId?.trim();
    const pdfUrl = body?.pdfUrl?.trim();
    if (!tenderId || !pdfUrl) {
      return NextResponse.json({ error: "DAO ou document PDF manquant." }, { status: 400 });
    }

    const { data: tender, error: tenderError } = await supabase
      .from("tenders")
      .select("id,title,reference,organization_id,document_url")
      .eq("id", tenderId)
      .eq("organization_id", member.organization_id)
      .single();
    if (tenderError || !tender || tender.document_url !== pdfUrl) {
      return NextResponse.json({ error: "DAO introuvable ou document non autorisé." }, { status: 404 });
    }

    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      return NextResponse.json({ error: "Le document PDF est inaccessible." }, { status: 502 });
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

    // Sécurité : si la variable OPENAI_DAO_MODEL a été mal configurée (par
    // exemple si elle contient une clé API par erreur au lieu d'un nom de
    // modèle), on ignore cette valeur et on revient au modèle par défaut
    // plutôt que d'envoyer une clé secrète à l'API comme si c'était un nom de
    // modèle.
    const rawDaoModel = process.env.OPENAI_DAO_MODEL;
    const daoModel = rawDaoModel && !rawDaoModel.startsWith("sk-") ? rawDaoModel : "gpt-5.4-mini";

    function redactSecrets(text: string) {
      return text.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[clé masquée]");
    }

    // Un fichier est téléversé directement à l'API plutôt que converti en base64.
    // Cela évite de gonfler fortement les gros DAO dans la requête HTTP.
    const uploadForm = new FormData();
    uploadForm.append("purpose", "user_data");
    uploadForm.append(
      "file",
      new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }),
      `DAO-${tender.reference || tender.id}.pdf`,
    );
    const uploadResponse = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: uploadForm,
    });
    if (!uploadResponse.ok) {
      const details = await uploadResponse.text();
      console.error("OpenAI DAO file upload failed", uploadResponse.status, details);
      return NextResponse.json({ error: "Le PDF du DAO n'a pas pu être envoyé au moteur IA." }, { status: 502 });
    }
    const uploadedFile = await uploadResponse.json() as { id?: string };
    if (!uploadedFile.id) return NextResponse.json({ error: "Identifiant du PDF IA indisponible." }, { status: 502 });

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: daoModel,
        store: false,
        // Le raisonnement reste volontairement concis : la source de vérité est le
        // PDF fourni, et non une longue recherche externe qui retarde l'analyse.
        reasoning: { effort: "low" },
        max_output_tokens: 32_000,
        instructions: [
          "Tu analyses un DAO de travaux publics ou BTP à Madagascar.",
          "Extrais uniquement les postes explicitement présents dans le document.",
          "Reproduis l'ordre et la structure exacte du bordereau DAO.",
          "Retourne une ligne row_type=section pour chaque titre d'ouvrage ou grande rubrique, par exemple TERRASSEMENT ou ÉQUIPEMENT.",
          "Retourne ensuite chaque poste avec row_type=item et section_title égal au titre de son ouvrage.",
          "Retourne une ligne row_type=subtotal à la fin de chaque ouvrage lorsqu'un sous-total existe dans le DAO.",
          "Pour chaque ligne du bordereau, renseigne parent_title et parent_reference avec la rubrique de récapitulation générale qui la contient exactement dans le DAO (par exemple parent_reference=A, parent_title=Bâtiment à deux salles ; parent_reference=B, parent_title=Latrines à trois compartiments). Quand il n'existe pas de rubrique parente, utilise une chaîne vide pour les deux. Ces champs servent à reproduire le récapitulatif du BDQE : ne les invente jamais.",
          "Extrais aussi bdqe_layout pour reproduire le BDQE exactement : source_reference cite toutes les pages BDQE; detail_table contient le titre exact, les colonnes exactes, le libellé du total et la source du tableau de détail; annotations contient chaque observation, note, mention fiscale, instruction, arrêté, lieu/date, signature ou paraphe imprimé dans le bordereau; recap_tables contient dans l'ordre exact chaque tableau de récapitulation, ses colonnes avec le libellé exact, ses lignes de désignation et son total. Ne fusionne jamais les tableaux Bâtiment, Latrines, Mobilier ou Récapitulation générale. Ces annotations et tableaux doivent apparaître dans les devis interne et externe; seul le devis externe comporte les emplacements de signature demandés par le DAO.",
          "Pour section et subtotal, conserve le libellé exact dans designation, utilise une unité vide et quantity=null.",
          "Ne fusionne jamais deux ouvrages et ne supprime jamais un titre ou un sous-total présent dans le DAO.",
          "Respecte les désignations, unités, quantités et numérotations du document.",
          "N'invente jamais une quantité, un prix, un lot ou une exigence.",
          "Pour une quantité absente, utilise null et needs_review=true.",
          "source_reference indique la page, section, lot ou bordereau justificatif.",
          "Renseigne execution_period_days avec le délai contractuel d'exécution indiqué dans le DAO, converti en jours; utilise null s'il est absent.",
          "Si le DAO fournit un planning ou plan d’exécution, extrais-le fidèlement dans execution_plan : tâches, ordre, durées et pages sources. Ce planning est celui à utiliser dans les PDF de soumission, sans le remplacer par un planning inventé. Prépare en parallèle site_execution_details pour le menu Chantier : détaille chaque tâche du planning DAO avec prédécesseur, personnel, matériel/équipement et point de contrôle, sans modifier le délai ou les obligations du DAO.",
          "Extrais la localisation précise du chantier (commune, district, région, repère ou coordonnées) depuis le DAO et ses plans. Renseigne worksite_location avec le lieu le plus précis confirmé et worksite_location_source avec les pages ou annexes du DAO. Si le lieu est ambigu, utilise la recherche web pour vérifier le nom géographique ou la carte, mais ne remplace jamais l’information du DAO par une supposition : indique l’ambiguïté dans warnings.",
          "Si le DAO contient une fiche, attestation, formulaire ou tableau de localisation du chantier, ajoute-le obligatoirement à submission_items, extrais ses champs et son modèle comme tout autre formulaire. Préremplis la localisation extraite du DAO dans prefilled_values et dans toutes les cases correspondantes du modèle PDF.",
          "Analyse particulièrement les clauses administratives, CCAP et leurs annexes. Si une clause administrative comporte un formulaire, une déclaration ou des cases à compléter, ajoute-la obligatoirement à submission_items avec sa page source, ses tableaux et ses champs. Préremplis les informations déjà dans le DAO et celles de l’entreprise ; le PDF doit reprendre le modèle DAO pour impression, signature et cachet.",
          "Le CCAP (Cahier des Clauses Administratives Particulières) lui-même doit presque toujours être paraphé/signé par le candidat, même quand il ne comporte aucune case à remplir : repère la page où commence son titre et ajoute-le obligatoirement à submission_items avec kind=document_to_provide, template_origin=dao. Un titre de section dans ce genre de DAO est presque toujours en majuscules, mais pas systématiquement (par exemple certaines annexes gardent une casse normale) : ne te fie donc jamais uniquement à la casse pour reconnaître un titre, repère-le par son sens et sa position en tête de page. Indique dans template_page_numbers uniquement cette PREMIÈRE page (pas une liste de pages), et la même page dans source_reference ; l'application détermine ensuite automatiquement où il se termine en suivant ce titre jusqu'à ce qu'un autre titre du DAO prenne le relais. Applique exactement la même règle à toute autre pièce du DAO qui exige une signature ou un paraphe sans être un formulaire à champs, notamment un calendrier cultural/agricole ou toute contrainte saisonnière d'exécution, un code de conduite, un règlement de chantier, ou toute annexe similaire : dès qu'un tel document existe dans le DAO, ajoute-le à submission_items avec sa première page, même sans aucun champ à remplir. Passe systématiquement en revue CHAQUE annexe numérotée du DAO (Annexe 1, Annexe 2, Annexe 3...), même si son titre n'est pas en majuscules : dès qu'une annexe constitue une pièce distincte à signer, parapher ou joindre à la soumission, ajoute-la à submission_items avec sa première page — ne te limite jamais aux seules annexes déjà citées explicitement dans ces instructions. Une annexe peut être une convention ou un accord entre PLUSIEURS parties (l'entreprise candidate ET d'autres parties comme la mairie, un ministère, une association locale...) : dans ce cas, n'extrais JAMAIS dans fields ou template_fill_positions les cases qui concernent une AUTRE partie que l'entreprise candidate (nom, fonction ou signature d'un maire, d'un chef de service, d'un tiers...) — elles doivent rester vides, ce n'est pas à l'entreprise de les remplir. En revanche, extrais bien dans fields et template_fill_positions les cases qui concernent spécifiquement l'entreprise candidate elle-même dans cette même annexe (son nom, son représentant, sa signature, la date de signature de sa propre partie), même quand le reste du document ne comporte aucun champ à elle destiné. N'invente jamais une pièce absente du DAO.",
          "Analyse également tout règlement, déclaration ou formulaire relatif aux litiges. S’il est demandé dans le dossier (notamment page 46 lorsqu’elle existe), ajoute-le à submission_items, conserve son modèle et ses tableaux, préremplis uniquement les valeurs disponibles dans le DAO ou le profil entreprise, puis rends-le disponible en PDF pour signature avant insertion.",
          "Ne calcule et ne propose aucun prix pendant l'analyse du DAO.",
          "Analyse tous les barèmes, méthodes et formules de calcul de prix du DAO, notamment le barème de la page 44 lorsqu’il existe. Extrais-les dans pricing_rules avec leur formule, leur champ d’application et leur page source. Ces règles doivent être utilisées lors du chiffrage uniquement pour les postes auxquels elles s’appliquent ; n’invente jamais de barème et n’applique jamais une règle hors de son champ.",
          "Place dans warnings toutes les ambiguïtés qui nécessitent une validation humaine.",
          "Après l'extraction fidèle, identifie séparément les coûts indispensables probablement absents du bordereau: ouvriers, maçons, ingénieurs, encadrement, engins, consommables, transport, installation et repli, sécurité et charges de chantier.",
          "Place ces compléments uniquement dans internal_cost_recommendations; ne les ajoute jamais à work_items.",
          "N'ajoute pas un complément déjà présent dans work_items, même si sa casse, ses accents ou son abréviation diffèrent.",
          "Pour une désignation ambiguë, renseigne les choix dans options et le choix provisoire le plus probable dans default_option.",
          "Toute hypothèse structurelle ou dimension d'acier doit avoir requires_validation=true et une safety_note demandant confirmation par les plans ou le BET.",
          "source_basis explique si la recommandation vient des exigences usuelles de travaux similaires à Madagascar ou d'une déduction du DAO.",
          "Pour chaque poste item, pricing_context résume les informations des plans, coupes, détails et CCTP utiles à son futur chiffrage, sans inventer un prix.",
          "À partir de la page 55 lorsque le DAO comporte les détails des ouvrages, lis intégralement chaque détail, coupe, tableau, plan et spécification technique. Rattache-les aux postes concernés dans work_items et pricing_context afin que le devis soit conforme aux dimensions, matériaux, méthodes, tolérances et exigences du DAO. Toute donnée illisible ou ambiguë doit être placée dans warnings et signalée needs_review=true, jamais devinée.",
          "À partir de la page 87 lorsque le DAO fournit les détails des chaises, équipements ou autres ouvrages complémentaires, vérifie chaque élément et ses dimensions. S’il est déjà au bordereau, complète uniquement son pricing_context. S’il est indispensable mais absent du bordereau, ajoute-le exclusivement à internal_cost_recommendations avec sa quantité, sa méthode de calcul et sa page source ; ne modifie jamais le bordereau officiel du DAO avec un élément inventé.",
          "Lorsque les pages 89 à 93 (ou des pages équivalentes) donnent les poids des matériaux à transporter, retranscris intégralement leur tableau dans transport_weight_table : conserve exactement le titre, les colonnes, chaque ligne, les unités, les poids et le total tels qu'ils sont lisibles dans le DAO. total_weight doit reprendre le total DAO, sans le recalculer ni l'estimer. source_reference doit citer les pages précises. Si aucun tableau lisible n'existe, retourne des chaînes et tableaux vides. Ces poids sont la seule source à utiliser pour les calculs de transport, le planning et la liste des matériaux : ne cherche pas sur Internet et ne les estime jamais lorsque le DAO fournit une valeur lisible.",
          "Lis aussi intégralement le Plan de gestion environnementale et sociale, les clauses environnementales et leurs annexes. Extrais dans environmental_restrictions chaque matériau, produit ou pratique explicitement interdit, avec la clause/page source. Pour chaque interdiction, propose suggested_equivalent : un équivalent techniquement et environnementalement plus conforme, ou une chaîne vide si aucun équivalent fiable ne peut être proposé. Si un poste DAO, un coût interne ou une recommandation contient ce matériau, signale l’interdiction dans pricing_context et warnings, avec needs_review=true, puis indique l’équivalent proposé comme option à valider. Ne cache jamais l’interdiction et ne remplace pas silencieusement le matériau dans le bordereau officiel.",
          "Pour le coffrage, examine les plans de semelles, poteaux, poutres, linteaux, chaînages et dalles; indique les dimensions, surfaces, répétitions et possibilités de réemploi déductibles.",
          "Si le plan est incomplet, fournis dans pricing_context une hypothèse prudente de calepinage clairement signalée à valider, au lieu de laisser une composition inexploitable.",
          "Cherche dans le DAO l'article, la clause ou le sommaire qui énumère la liste complète des pièces à fournir pour la soumission (par exemple un article intitulé « Dossier d'Appel d'Offres », « Composition du dossier de soumission » ou équivalent selon le DAO). Recopie cette énumération telle quelle, avec l'intitulé exact de chaque ligne (parties, formulaires, annexes, chapitres...) dans submission_checklist, en gardant EXACTEMENT son ordre d'apparition dans ce sommaire : sequence commence à 1 et augmente de 1 pour chaque ligne, y compris les sous-parties et sous-annexes listées séparément. Renseigne source_reference avec la page indiquée pour cette ligne dans le sommaire, ou une chaîne vide si aucune page n'y est indiquée. Cette liste sert UNIQUEMENT à fixer l'ordre d'affichage des pièces détectées dans submission_items : elle reste totalement séparée de leur contenu, page réelle, modèle ou champs, qui restent décrits uniquement dans submission_items. N'invente jamais une ligne absente de ce sommaire et ne fusionne jamais deux lignes distinctes ; si le DAO ne contient aucun sommaire de ce type, retourne submission_checklist=[].",
          "Renseigne aussi level pour chaque ligne de submission_checklist, afin que l'application puisse afficher les titres de ce sommaire exactement comme le DAO les présente : level=0 pour une grande division du sommaire (par exemple « Partie I », « Partie II », un titre ou chapitre principal en chiffres romains, en gras ou en plus gros qui regroupe plusieurs lignes en dessous), et level=1 pour chaque ligne secondaire placée sous cette division (tiret, sous-point, formulaire ou annexe nommé individuellement). Si le sommaire du DAO est plat, sans regroupement visible en grandes divisions, mets level=1 pour toutes les lignes et n'invente aucune division qui n'existe pas dans le DAO.",
          "Analyse aussi toutes les pièces de soumission demandées dans le DAO, y compris les annexes, formulaires, attestations, garanties et justificatifs.",
          "Place chaque pièce explicitement demandée dans submission_items : kind=document_to_provide pour une pièce à joindre et kind=form_to_complete pour un formulaire, une lettre ou une déclaration à compléter.",
          "Le critère décisif entre document_to_provide et form_to_complete n'est jamais l'intitulé donné par le DAO mais l'état réel du modèle sur sa page : dès que le modèle DAO d'une pièce comporte des blancs, tirets, pointillés, mentions entre crochets à remplacer, ou un tableau partiellement vide à compléter (montant, durée, référence, banque, date, nom du candidat...), utilise obligatoirement kind=form_to_complete, même si le DAO la liste parmi les pièces jointes plutôt que parmi les formulaires — c'est notamment le cas fréquent de la garantie bancaire de soumission, de la caution personnelle et solidaire et de la garantie de bonne exécution. Repère précisément chaque blanc et chaque cellule de tableau à remplir avec template_fill_positions et template_tables (colonnes et lignes exactes du DAO), crée une clé dans fields pour chaque valeur réellement inconnue, et préremplis dans prefilled_values toute valeur déjà disponible dans le DAO ou le profil entreprise. Le PDF généré doit reproduire le modèle DAO lettre pour lettre et tableau pour tableau, avec uniquement les blancs effectivement remplis à la place des espaces à compléter — jamais une simple instruction de signature sans le modèle rempli.",
          "Ne crée aucun item si le DAO ne le demande pas explicitement. Ne transforme jamais une simple information de contexte en pièce à fournir.",
          "Pour un formulaire, fields doit contenir CHAQUE blanc, tiret, case ou ligne à compléter visible sur ses pages DAO — jamais seulement 2 ou 3 champs génériques (nom, date, référence) alors que la page en montre davantage. Relis la page entière ligne par ligne et transforme chaque étiquette suivie d'un blanc en un champ distinct : par exemple, en plus de legal_name/address/phone/email/nif/stat/representative_name/signature_date, n'oublie jamais des champs comme la forme juridique, l'agence et le numéro de compte bancaire et son intitulé, l'adresse/le numéro de télécopie/l'adresse électronique de la personne habilitée à représenter le candidat, la liste des copies de documents annexés, ou une description de procédure de redressement judiciaire — et tout autre blanc similaire propre à ce DAO. key doit être un identifiant simple en minuscules.",
          "source_reference doit indiquer la page, l'annexe ou l'article source. instructions explique brièvement ce qui est attendu, sans inventer de condition.",
          "Pour un modèle de panneau de chantier, plaque TALIM ou document graphique, cherche d'abord dans toutes les pages, annexes, illustrations et tableaux du DAO.",
          "Si un modèle est présent, indique précisément sa page dans source_reference et demande de l'utiliser. S'il est absent ou illisible, indique clairement qu'un modèle équivalent ou une insertion manuelle est nécessaire; ne présente jamais un modèle inventé comme officiel.",
          "Pour une liste des plans, extrais obligatoirement le registre complet dans plan_register : retranscris le titre, les colonnes, chaque plan ou dessin, son numéro/référence, sa désignation et toutes les informations visibles. Conserve l'ordre exact du DAO. total_count doit indiquer le nombre de plans réellement listés; source_reference doit citer les pages ou annexes. Les planches de plans techniques sont presque toujours regroupées en un seul bloc de pages CONSÉCUTIVES dans le DAO (parfois une centaine de pages à la suite), et n'ont souvent aucun texte lisible (dessin vectoriel pur) — ce n'est pas une page vide, c'est normal. Ne cherche donc pas à lister page par page : page_numbers doit contenir uniquement le NUMÉRO DE LA PREMIÈRE page de ce bloc (celle juste après la fin du texte qui précède, où commencent réellement les dessins), pas une liste éparse. Vérifie que cette première page n'appartient à aucun autre document déjà identifié dans submission_items. L'application se charge ensuite de déterminer automatiquement où s'arrête ce bloc de pages. Si tu ne peux pas déterminer avec certitude où commencent les planches, retourne des chaînes et tableaux vides et page_numbers=[]. Utilise ces données dans les instructions de la pièce « Liste des plans ».",
          "Toute valeur déjà donnée par le DAO doit être préremplie et ne doit jamais être redemandée au candidat. Ajoute-la dans prefilled_values avec EXACTEMENT la même key que le champ concerné dans fields — une key différente (même proche, par exemple transport_price_cap pour un champ transport_price) rend la valeur totalement invisible : elle n'atteint jamais le champ et le candidat doit alors la retaper alors qu'elle était déjà connue. Vérifie donc que chaque entrée de prefilled_values correspond à une key réellement présente dans fields de ce même submission_item. Cela inclut notamment les montants, monnaies, pourcentages, durées et références des garanties bancaire ou personnelle, les dates limites, l’autorité contractante, le numéro de marché, les montants du devis et les valeurs imprimées dans les tableaux.",
          "Ne préremplis jamais un champ de personnel, matériel, capacité technique, antécédent, litige, expérience, diplôme, désignation, description ou statut avec les données du gérant, du profil de l’entreprise, du NIF ou du STAT, sauf si le DAO demande explicitement cette donnée d’entreprise dans ce champ précis.",
          "Pour les modèles de personnel ou de matériels, ne compte jamais le gérant ou représentant légal comme personnel de chantier. Prévois une ligne vide par personne ou matériel à ajouter, et crée dans fields les clés personnel_1_name, personnel_1_role, personnel_1_qualification, personnel_1_experience (ou materiel_1_name, materiel_1_role, materiel_1_qualification, materiel_1_experience) ainsi que leurs positions dans template_fill_positions. Répète ces positions pour chaque ligne du tableau visible afin que l’utilisateur puisse ajouter plusieurs personnels ou matériels et obtenir le PDF exactement sur le tableau du DAO.",
          "Règle spéciale personnel : si l’Annexe 3 page 233 est présente, elle correspond uniquement à la liste des personnels affectés au chantier et à son tableau. Ne la duplique pas. Toute autre pièce demandant un contrat, petit contrat ou engagement de travail doit devenir un submission_item distinct de type form_to_complete, intitulé « Contrat individuel de travail ». Ce contrat doit être généré une fois par personnel de la liste Annexe 3, prérempli avec son nom, fonction et CIN. Cherche d’abord son modèle exact dans le DAO avec ses pages, tableau et zones à remplir ; seulement si aucun modèle n’existe, prépare un modèle généré à imprimer et indique clairement qu’il doit être vérifié avant signature.",
          "Pour tout formulaire ou document qui doit être rempli ou généré, applique impérativement cet ordre : 1) cherche d’abord un modèle dans le DAO et toutes ses annexes ; 2) seulement s’il n’existe aucun modèle exploitable, utilise la recherche web pour trouver un modèle équivalent fiable ; 3) seulement en dernier recours, prépare un modèle générique à vérifier.",
          "Pour chaque submission_item, remplis template_origin avec dao, internet, generated ou none. template_source_url contient l’URL vérifiée seulement si template_origin=internet, sinon une chaîne vide. template_text contient le texte ou la structure utile du modèle seulement s’il faut le générer/imprimer ; sinon une chaîne vide. Si template_origin=dao, template_page_numbers contient les pages originales 1-indexées à imprimer, et template_fill_positions contient les positions précises des champs sur la page : page source, field_key, x_percent et y_percent mesurés depuis le coin supérieur gauche, width_percent. Ces positions doivent couvrir aussi les cellules des tableaux. template_tables contient les tableaux du modèle à reproduire avec exactement leurs colonnes, lignes, ordre et intitulés visibles dans le DAO ; utilise [] lorsqu’il n’y a pas de tableau. organization_column_indexes contient les indices à partir de 0 des seules colonnes destinées au candidat qui utilise l’application ; pour un tableau général, indique toutes ses colonnes. Si le tableau concerne plusieurs organismes, candidats, années ou lots, n’indique que la colonne du soumissionnaire courant et ne mets jamais ses données dans les autres colonnes. Dans template_text et dans les seules cellules des colonnes concernées, remplace tout emplacement à compléter par {{cle_du_champ}}, par exemple {{legal_name}}, {{nif}}, {{signature_date}} ou {{contract_reference}}. Ajoute obligatoirement ces clés dans fields afin que l’application préremplisse les données disponibles et demande seulement les valeurs absentes. Ne présente jamais un modèle Internet ou généré comme un modèle officiel du DAO.",
          "Erreur fréquente à éviter dans template_tables : une cellule destinée au candidat (montant, date, quantité, référence, désignation...) reçoit une clé {{cle_du_champ}} MÊME quand elle apparaît simplement vide dans le DAO, sans aucun pointillé, tiret ou crochet visible — une case vide dans un tableau à remplir est un emplacement à compléter au même titre qu'une case avec pointillés. Ne laisse jamais une telle cellule vide sans clé sous prétexte qu'elle ne contient aucun caractère de remplissage.",
          "Renseigne repeatable=true pour un tableau dont le DAO ne montre qu'une ou deux lignes d'exemple par rubrique alors que le nombre réel d'entrées dépend de l'historique du candidat — notamment les litiges des cinq dernières années, les conventions ou marchés non exécutés, la liste des travaux ou marchés similaires déjà exécutés, ou tout chiffre d'affaires par exercice qui ne correspond pas à des colonnes d'années déjà fixées par le DAO. Pour un tel tableau, ne numérote jamais les clés : utilise des clés de colonne génériques et réutilisables sur une seule ligne d'exemple (par exemple {{annee}}, {{montant}}, {{identification}}, {{fraction_non_executee}}), jamais {{annee_1}} ni {{montant_2}} — l'application duplique ensuite cette ligne autant de fois que l'utilisateur en a besoin, avec les mêmes clés à chaque fois. Renseigne repeatable=false pour un tableau dont le nombre de lignes et de colonnes est toujours fixe et connu à l'avance (par exemple un chiffre d'affaires réparti sur des colonnes d'exercices précises déjà indiquées par le DAO) : dans ce cas seulement, donne une clé distincte à chaque cellule (par exemple {{travaux_exercice_1}}, {{fournitures_exercice_2}}).",
          "Règle impérative d'impression : pour chaque pièce dont le titre, les instructions ou le DAO demandent une signature, un paraphe, un cachet ou une impression, ne retourne jamais une simple instruction. Cherche son modèle et ses pages dans le DAO. Si elles existent, utilise obligatoirement template_origin=dao, liste toutes les template_page_numbers à imprimer et renseigne toutes les template_fill_positions et template_tables nécessaires pour une version entièrement préremplie. Si aucun modèle DAO exploitable n'existe, utilise un modèle équivalent fiable ou prépare un document complet à imprimer avec template_text et les fields, jamais un simple résumé. Chaque valeur présente dans le DAO ou le profil entreprise doit être inscrite dans prefilled_values; seuls les champs réellement inconnus restent à demander au candidat.",
          "Presque tous les modèles DAO se terminent par un bloc de signature (souvent \"Nom : [...] Titre/Qualité : [...] Signé [...]\"). N'oublie jamais ce bloc dans fields, même quand le reste de la pièce n'a que peu de champs : ajoute systématiquement une clé pour le nom du signataire et une pour sa fonction/qualité (préremplies depuis le représentant légal de l'entreprise dans prefilled_values), en plus de tous les autres blancs entre crochets ou pointillés déjà présents sur ces mêmes pages.",
          "template_fill_positions n'est jamais optionnel : dès que template_origin=dao et que fields contient au moins une clé, template_fill_positions DOIT contenir une position (page, field_key, x_percent, y_percent, width_percent) pour CHAQUE champ de fields, sinon la valeur préremplie n'apparaît nulle part sur le document final et le candidat reçoit un modèle vierge malgré des informations déjà connues. Regarde où se trouve concrètement le blanc, le tiret ou la case correspondante sur la page (visible dans le PDF fourni) et estime sa position en pourcentage de la largeur/hauteur de page depuis le coin supérieur gauche ; une estimation raisonnable vaut toujours mieux qu'une position absente.",
          "Cette même règle vaut pour CHAQUE case vide d'un tableau, pas seulement pour les champs hors tableau : erreur fréquente observée à corriger — un formulaire avec tableau (ex. chiffres d'affaires des 3 derniers exercices, litiges intervenus, travaux similaires déjà exécutés) ne doit jamais s'arrêter aux champs de nom/date/référence en dehors du tableau. Chaque cellule de la colonne du candidat qui est vide dans le DAO et doit recevoir une valeur (un montant, une année, une désignation...) est un champ manquant comme un autre : remplace-la par {{cle_du_champ}} dans template_tables ET crée l'entrée correspondante dans fields, avec sa position dans template_fill_positions si cette cellule doit être écrite directement sur la page DAO reproduite. N'omets jamais les cellules d'un tableau sous prétexte que les champs hors tableau sont déjà couverts.",
        ].join(" "),
        input: [{
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: uploadedFile.id,
            },
            {
              type: "input_text",
              text: [
                `DAO: ${tender.reference || "sans référence"} — ${tender.title}`,
                "Lis directement toutes les pages et leurs tableaux visuels.",
                "Préserve chaque titre d'ouvrage, sous-titre, ligne, numérotation et sous-total dans son ordre d'apparition.",
              ].join("\n"),
            },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "dao_work_items",
            strict: true,
            schema: daoSchema,
          },
        },
      }),
    });
    // Le DAO reste privé dans Supabase : la copie temporaire envoyée à l'IA est supprimée.
    void fetch(`https://api.openai.com/v1/files/${uploadedFile.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!aiResponse.ok) {
      const details = await aiResponse.text();
      console.error("OpenAI DAO analysis failed", aiResponse.status, details);
      const isTimeout = aiResponse.status === 408 || aiResponse.status === 504;
      return NextResponse.json({
        error: isTimeout
          ? "L'analyse du DAO a pris trop de temps. Réessayez : le DAO reste enregistré et aucune donnée existante n'est supprimée."
          : "Le moteur d'analyse n'a pas pu terminer le DAO. Réessayez dans un instant.",
        upstream_status: aiResponse.status,
        details: redactSecrets(details).slice(0, 500),
      }, { status: 502 });
    }

    const aiPayload = await aiResponse.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const outputText = extractResponseText(aiPayload);
    if (!outputText) return NextResponse.json({ error: "Réponse IA vide." }, { status: 502 });

    let structured: {
      summary: string;
      execution_period_days: number | null;
      execution_plan: Array<{ title: string; duration_days: number | null; sequence: number; source_reference: string }>;
      site_execution_details: Array<{ title: string; predecessor: string; personnel: string; materials_or_equipment: string; control_point: string }>;
      worksite_location: string;
      worksite_location_source: string;
      pricing_rules: Array<{ title: string; formula: string; applicable_to: string; source_reference: string }>;
      transport_weight_table: { title: string; columns: string[]; rows: string[][]; total_label: string; total_weight: string; source_reference: string };
      plan_register: { title: string; columns: string[]; rows: string[][]; total_label: string; total_count: string; source_reference: string; page_numbers: number[] };
      bdqe_layout: { source_reference: string; annotations: string[]; detail_table: { title: string; columns: string[]; total_label: string; source_reference: string }; recap_tables: Array<{ reference: string; title: string; columns: string[]; row_titles: string[]; total_label: string; source_reference: string }> };
      environmental_restrictions: Array<{ material: string; restriction: string; suggested_equivalent: string; source_reference: string }>;
      work_items: Array<{
        row_type: "section" | "item" | "subtotal";
        section_title: string;
        designation: string;
        category: string;
        unit: string;
        quantity: number | null;
        source_reference: string;
        needs_review: boolean;
        note: string;
        pricing_context: string;
      }>;
      warnings: string[];
      submission_checklist: Array<{ title: string; sequence: number; source_reference: string; level: number }>;
      internal_cost_recommendations: Array<{
        kind: "labor" | "material" | "equipment" | "service" | "overhead";
        title: string;
        designation: string;
        unit: string;
        quantity: number | null;
        reason: string;
        source_basis: string;
        options: string[];
        default_option: string;
        requires_validation: boolean;
        safety_note: string;
      }>;
      submission_items: Array<{
        kind: "document_to_provide" | "form_to_complete";
        title: string;
        source_reference: string;
        instructions: string;
        required: boolean;
        prefilled_values: Array<{ key: string; value: string }>;
        template_origin: "dao" | "internet" | "generated" | "none";
        template_source_url: string;
        template_text: string;
        template_page_numbers: number[];
        template_fill_positions: Array<{ page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number }>;
        template_tables: Array<{ title: string; columns: string[]; rows: string[][]; organization_column_indexes: number[]; repeatable: boolean }>;
        fields: Array<{ key: string; label: string; required: boolean; description: string }>;
      }>;
    };
    const parsedOutput = parseStructuredResponse(outputText);
    if (!parsedOutput) {
      // Aucun enregistrement n'est modifié ici : l'analyse précédente du DAO
      // reste donc utilisable au lieu d'être remplacée par un résultat incomplet.
      return NextResponse.json({
        error: "La nouvelle analyse est incomplète. L'analyse précédente du DAO a été conservée.",
      }, { status: 502 });
    }
    structured = parsedOutput as typeof structured;

    const analysis = {
      schema_version: "dao-visual-structured-v11",
      ...structured,
      resume: structured.summary,
      lots: structured.work_items.map((item) => ({
        row_type: item.row_type,
        section_title: item.section_title,
        designation: item.designation,
        categorie: item.category,
        quantite: item.quantity,
        unite: item.unit,
        source_reference: item.source_reference,
        needs_review: item.needs_review,
        note: item.note,
        pricing_context: item.pricing_context,
      })),
    };

    const { error: updateError } = await supabase
      .from("tenders")
      .update({
        ai_analysis: analysis,
        status: "analyzed",
      })
      .eq("id", tender.id);
    if (updateError) {
      console.error("DAO analysis save failed", updateError);
      return NextResponse.json({ error: "Analyse produite, mais enregistrement impossible." }, { status: 500 });
    }

    return NextResponse.json({ success: true, analysis });
  } catch (error) {
    console.error("DAO analysis error", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur pendant l'analyse du DAO." },
      { status: 500 },
    );
  }
}
