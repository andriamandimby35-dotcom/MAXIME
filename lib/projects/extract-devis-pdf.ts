// Lecture d'un devis PDF par l'IA : liste des travaux (planning) et lignes
// chiffrées (catégorie, sous-catégorie, quantité, prix unitaire). Partagé par la
// création d'un chantier (/api/projects/extract-tasks-from-pdf) et par
// l'import des prix d'un chantier déjà créé (/api/billing/projects/[id]/import-devis).
// Le PDF n'est jamais stocké : copie temporaire côté IA, supprimée aussitôt.

/** ref / description / concerne : texte d'origine du bordereau (numéro, texte complet de l'article, ligne « Concerne »), pour que le PDF généré ressemble à l'original. */
export type DevisPriceLine = { category: string; subcategory: string; designation: string; unit: string; quantity: number; unit_price: number; ref?: string; description?: string; concerne?: string };
export type DevisExtraction = { works: string[]; project_name: string; location: string; price_lines: DevisPriceLine[]; /** Toutes les lignes du devis, y compris celles sans prix (unit_price = 0). */ all_lines: DevisPriceLine[]; devis_total: number | null; /** Taux « TMP » écrit sous le total du devis (ex. 8), sinon null. */ tmp_percent: number | null };
export type DevisExtractionResult = { ok: true; data: DevisExtraction } | { ok: false; status: number; body: Record<string, unknown> };

function extractResponseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

export async function extractDevisFromPdf(file: File): Promise<DevisExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, status: 503, body: { error: "OPENAI_API_KEY n'est pas configurée." } };

  // Sécurité : si la variable OPENAI_MODEL a été mal configurée (par exemple
  // si elle contient une clé API par erreur au lieu d'un nom de modèle), on
  // ignore cette valeur et on revient au modèle par défaut plutôt que
  // d'envoyer une clé secrète à l'API comme si c'était un nom de modèle.
  const rawModel = process.env.OPENAI_MODEL;
  const model = rawModel && !rawModel.startsWith("sk-") ? rawModel : "gpt-5.4-mini";

  function redactSecrets(text: string) {
    return text.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[clé masquée]");
  }

  // Le PDF est envoyé une seule fois au moteur IA (fichier temporaire), puis
  // supprimé aussitôt après l'analyse : il n'est jamais stocké côté Sébastien.
  const uploadForm = new FormData();
  uploadForm.append("purpose", "user_data");
  uploadForm.append("file", file, file.name || "devis.pdf");
  const uploadResponse = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: uploadForm,
  });
  if (!uploadResponse.ok) {
    const details = await uploadResponse.text();
    console.error("OpenAI devis file upload failed", uploadResponse.status, details);
    return { ok: false, status: 502, body: { error: "Le PDF n'a pas pu être envoyé au moteur IA." } };
  }
  const uploadedFile = await uploadResponse.json() as { id?: string };
  if (!uploadedFile.id) return { ok: false, status: 502, body: { error: "Identifiant du PDF IA indisponible." } };

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "medium" },
      // Une partie du budget est consommée par le raisonnement interne du
      // modèle (nécessaire pour bien réordonner la liste) avant même d'écrire
      // la réponse : un budget trop court peut couper la réponse en plein
      // milieu (JSON incomplet, donc invalide) pour un devis avec beaucoup de
      // lignes de travaux, d'où une marge large ici.
      max_output_tokens: 48000,
      instructions: [
        "Tu lis un devis de travaux de bâtiment (BTP) à Madagascar.",
        "Pour la liste 'works' (planning), ignore les prix et les montants : seuls les travaux comptent.",
        "En plus, remplis 'price_lines' avec chaque ligne CHIFFRÉE du devis, dans l'ordre du document : category = titre de la catégorie ou du lot principal auquel la ligne appartient (chaîne vide s'il n'y en a pas), subcategory = titre de la sous-catégorie ou sous-section à l'intérieur de cette catégorie (chaîne vide s'il n'y en a pas), exactement comme écrits dans le devis, designation = le même titre court que dans 'works', unit = unité écrite, quantity = quantité, unit_price = prix unitaire en Ariary tel qu'écrit dans le devis. Le relevé doit être COMPLET : parcours TOUTES les pages et TOUS les tableaux, n'omets aucune ligne chiffrée (même courte, même répétée sur plusieurs pages, même si son prix est dans un tableau récapitulatif). Avant de répondre, additionne quantité × prix unitaire de toutes tes lignes et compare avec le total général du devis : si l'écart dépasse 1 %, relis le document et ajoute les lignes manquantes. N'inclus jamais une ligne de titre, de sous-total ou de total dans price_lines. N'invente JAMAIS un prix : une ligne de travaux dont le devis ne donne PAS de prix unitaire est quand même listée dans price_lines, avec unit_price = null (le prix sera cherché plus tard). 'devis_total' = le total général du devis s'il est écrit, sinon null. Pour CHAQUE ligne, recopie aussi le texte d'origine : ref = le numéro de la ligne tel qu'écrit (ex. \"0.1\", \"I.4\", \"XI.15\"), description = le texte complet de l'article tel qu'écrit dans le devis (sans le numéro, sans l'unité, sans les nombres, sans la ligne « Concerne »), concerne = ce qui suit « Concerne : » (chaîne vide s'il n'y en a pas). 'tmp_percent' = le pourcentage de la ligne « TMP » écrite sous le total (ex. 8 pour « TMP 8% »), sinon null.",
        "Extrais la liste des travaux à réaliser : chaque poste ou ligne de travail réel devient une entrée.",
        "Donne un titre court et clair pour chaque travail (sans numérotation ni prix).",
        "Ignore les lignes qui ne sont que des titres de section, des sous-totaux ou des totaux : elles ne sont pas des travaux.",
        "N'invente jamais un travail absent du devis : reformule seulement ce qui y figure déjà.",
        "Étape 1 : extrais d'abord tous les travaux dans l'ordre du document, sans réfléchir à l'ordre final.",
        "Étape 2 (obligatoire, à faire ensuite, séparément) : réorganise entièrement cette liste extraite pour qu'elle corresponde à l'ordre réel d'exécution d'un chantier BTP, PAS à l'ordre du document. Le devis regroupe souvent 'installation de chantier' et 'repli de chantier' côte à côte au début du bordereau (ce sont deux lignes de prix voisines) : c'est un ordre de FACTURATION, pas un ordre de TRAVAUX. Tu dois les séparer : 'installation de chantier' reste en position 1, mais 'repli de chantier' doit être déplacé tout en bas de la liste, après absolument tous les autres travaux, même s'il apparaît juste après l'installation dans le devis.",
        "Vérifie toi-même avant de répondre : la toute dernière entrée de 'works' doit être un travail de fin de chantier (repli de chantier, nettoyage final, remise en état, réception des travaux) si un tel travail existe dans le devis ; s'il n'y en a pas, la dernière entrée est simplement le dernier travail de finition. Si ce n'est pas le cas, corrige l'ordre avant de répondre.",
        "Entre le début (installation) et la fin (repli), respecte l'ordre réel d'exécution : terrassement et fondations, puis gros œuvre (structure, élévation, toiture), puis second œuvre (cloisons, enduits, menuiserie, électricité, plomberie), puis finitions et peinture.",
        "Ne réordonne que les travaux réellement présents dans le devis : si une étape (installation, repli, etc.) n'existe pas dans le document, ne l'invente pas, saute-la simplement.",
        "Si le devis indique un nom de projet, de chantier ou de client, indique-le dans project_name ; sinon laisse une chaîne vide.",
        "Si une localisation est mentionnée, indique-la dans location ; sinon laisse une chaîne vide.",
      ].join(" "),
      input: [{
        role: "user",
        content: [
          { type: "input_file", file_id: uploadedFile.id },
          { type: "input_text", text: "Lis directement toutes les pages et leurs tableaux." },
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "devis_work_items",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              project_name: { type: "string" },
              location: { type: "string" },
              works: { type: "array", items: { type: "string" } },
              price_lines: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    category: { type: "string" },
                    subcategory: { type: "string" },
                    designation: { type: "string" },
                    unit: { type: "string" },
                    quantity: { type: ["number", "null"] },
                    unit_price: { type: ["number", "null"] },
                    ref: { type: "string" },
                    description: { type: "string" },
                    concerne: { type: "string" },
                  },
                  required: ["category", "subcategory", "designation", "unit", "quantity", "unit_price", "ref", "description", "concerne"],
                },
              },
              devis_total: { type: ["number", "null"] },
              tmp_percent: { type: ["number", "null"] },
            },
            required: ["project_name", "location", "works", "price_lines", "devis_total", "tmp_percent"],
          },
        },
      },
    }),
  });

  // Le devis reste privé : la copie temporaire envoyée à l'IA est supprimée.
  void fetch(`https://api.openai.com/v1/files/${uploadedFile.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("OpenAI devis PDF analysis failed", aiResponse.status, details);
    const isTimeout = aiResponse.status === 408 || aiResponse.status === 504;
    return { ok: false, status: 502, body: {
      error: isTimeout
        ? "L'analyse du PDF a pris trop de temps. Réessayez."
        : "L'analyse du PDF a échoué. Réessayez.",
      upstream_status: aiResponse.status,
      details: redactSecrets(details).slice(0, 500),
    } };
  }

  const aiPayload = await aiResponse.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    status?: string;
    incomplete_details?: { reason?: string };
  };
  const outputText = extractResponseText(aiPayload);
  if (!outputText) {
    // Diagnostic : une réponse vide vient souvent d'un budget de tokens trop
    // court (le raisonnement interne consomme tout avant d'écrire la sortie).
    console.error("[extract-tasks-from-pdf] empty AI response", {
      status: aiPayload.status,
      incompleteReason: aiPayload.incomplete_details?.reason,
    });
    const reasonNote = aiPayload.incomplete_details?.reason ? ` (${aiPayload.incomplete_details.reason})` : "";
    return { ok: false, status: 502, body: { error: `Réponse IA vide${reasonNote}. Réessayez.` } };
  }

  let parsed: { project_name?: string; location?: string; works?: string[]; price_lines?: Array<{ category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number | null; unit_price?: number | null; ref?: string; description?: string; concerne?: string }>; devis_total?: number | null; tmp_percent?: number | null };
  try {
    parsed = JSON.parse(outputText);
  } catch {
    // Diagnostic : si la réponse a été coupée avant la fin (budget de tokens
    // atteint), le texte reçu ressemble à du JSON mais s'arrête en plein
    // milieu, ce qui casse le JSON.parse ci-dessus. On distingue ce cas
    // précis pour guider la correction (augmenter encore le budget, ou
    // réduire le nombre de travaux traités en une fois).
    const truncated = aiPayload.status === "incomplete";
    console.error("[extract-tasks-from-pdf] invalid AI JSON", {
      status: aiPayload.status,
      incompleteReason: aiPayload.incomplete_details?.reason,
      outputLength: outputText.length,
      outputPreview: outputText.slice(-300),
    });
    const note = truncated
      ? " (réponse coupée avant la fin — devis probablement trop long pour le budget actuel)"
      : "";
    return { ok: false, status: 502, body: { error: `Réponse IA invalide${note}. Réessayez.` } };
  }

  const works = (parsed.works ?? []).map((title) => title.trim()).filter(Boolean);
  if (!works.length) return { ok: false, status: 422, body: { error: "Aucun travail n'a pu être identifié dans ce PDF." } };

  // Lignes chiffrées : on ne garde que celles qui ont vraiment un prix
  // unitaire (jamais de prix deviné) ; une quantité absente compte pour 1.
  const allLines = (parsed.price_lines ?? [])
    .map((line) => ({
      category: String(line.category ?? "").trim(),
      subcategory: String(line.subcategory ?? "").trim(),
      designation: String(line.designation ?? "").trim(),
      unit: String(line.unit ?? "").trim(),
      quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1,
      unit_price: Number(line.unit_price) || 0,
      ref: String(line.ref ?? "").trim(),
      description: String(line.description ?? "").trim(),
      concerne: String(line.concerne ?? "").trim(),
    }))
    .filter((line) => line.designation);
  const priceLines = allLines.filter((line) => line.unit_price > 0);
  return {
    ok: true,
    data: {
      works,
      project_name: (parsed.project_name || "").trim(),
      location: (parsed.location || "").trim(),
      price_lines: priceLines,
      all_lines: allLines,
      devis_total: Number(parsed.devis_total) > 0 ? Number(parsed.devis_total) : null,
      tmp_percent: Number(parsed.tmp_percent) > 0 ? Number(parsed.tmp_percent) : null,
    },
  };
}
