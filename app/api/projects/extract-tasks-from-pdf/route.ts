import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

function extractResponseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

// Étape "automatique" de la création d'un chantier : on donne directement un
// PDF de devis (pas forcément un devis déjà enregistré dans Sébastien), et on
// en extrait uniquement la liste des travaux à réaliser pour construire le
// planning du chantier. Les prix ne sont ni lus ni conservés, et le PDF
// lui-même n'est pas enregistré : cette route ne fait qu'analyser, la
// création du chantier se fait ensuite via /api/projects (mode "manual"),
// avec la liste vérifiée/corrigée par l'utilisateur.
export async function POST(request: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

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
    return NextResponse.json({ error: "Le PDF n'a pas pu être envoyé au moteur IA." }, { status: 502 });
  }
  const uploadedFile = await uploadResponse.json() as { id?: string };
  if (!uploadedFile.id) return NextResponse.json({ error: "Identifiant du PDF IA indisponible." }, { status: 502 });

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      store: false,
      reasoning: { effort: "medium" },
      // Une partie du budget est consommée par le raisonnement interne du
      // modèle (nécessaire pour bien réordonner la liste) avant même d'écrire
      // la réponse : un budget trop court peut couper la réponse en plein
      // milieu (JSON incomplet, donc invalide) pour un devis avec beaucoup de
      // lignes de travaux, d'où une marge large ici.
      max_output_tokens: 32000,
      instructions: [
        "Tu lis un devis de travaux de bâtiment (BTP) à Madagascar.",
        "Ignore complètement les prix, quantités en unité de prix, montants, totaux et marges : ils ne servent à rien ici.",
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
            },
            required: ["project_name", "location", "works"],
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
    return NextResponse.json({ error: "L'analyse du PDF a échoué. Réessayez." }, { status: 502 });
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
    return NextResponse.json({ error: `Réponse IA vide${reasonNote}. Réessayez.` }, { status: 502 });
  }

  let parsed: { project_name?: string; location?: string; works?: string[] };
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
    return NextResponse.json({ error: `Réponse IA invalide${note}. Réessayez.` }, { status: 502 });
  }

  const works = (parsed.works ?? []).map((title) => title.trim()).filter(Boolean);
  if (!works.length) return NextResponse.json({ error: "Aucun travail n'a pu être identifié dans ce PDF." }, { status: 422 });

  return NextResponse.json({
    works,
    project_name: (parsed.project_name || "").trim(),
    location: (parsed.location || "").trim(),
  });
}
