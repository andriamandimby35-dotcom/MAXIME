import { NextResponse } from "next/server";
import sharp from "sharp";
import { createServerClient } from "@/lib/supabase/server";

function extractResponseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

// Analyse visuelle (IA) des photos d'un rapport journalier : compare
// approximativement ce qui est visible sur les photos aux matériaux déclarés
// utilisés dans le rapport, pour repérer une éventuelle surconsommation, une
// erreur de déclaration ou une incohérence. Rien n'est enregistré ici — seul
// le bouton "Signaler" côté client crée une remarque, avec confirmation.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { report_id: reportId } = await request.json();
  if (!reportId) return NextResponse.json({ error: "Rapport manquant." }, { status: 400 });

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project } = await supabase.from("projects").select("id, organization_id, name").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.active || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Seul l'administrateur peut lancer l'analyse IA." }, { status: 403 });
  }

  const { data: report } = await supabase.from("project_daily_reports").select("*").eq("id", reportId).eq("project_id", projectId).maybeSingle();
  if (!report) return NextResponse.json({ error: "Rapport introuvable." }, { status: 404 });

  const { data: photos } = await supabase.from("project_photos").select("id, storage_path, caption, photo_type").eq("report_id", reportId);
  if (!photos?.length) return NextResponse.json({ error: "Aucune photo liée à ce rapport." }, { status: 400 });

  const { data: usages } = await supabase
    .from("project_report_material_usages")
    .select("quantity, unit, material_id, project_materials(designation)")
    .eq("report_id", reportId);

  // Le modèle IA n'accepte que jpeg/png/gif/webp, alors que le stockage
  // accepte tout format image (HEIC/AVIF compris, pour les photos de
  // téléphone). On télécharge chaque photo et on la convertit en JPEG avant
  // de l'envoyer, plutôt que de compter sur le format d'origine.
  const convertedImages = await Promise.all(photos.map(async (photo) => {
    const { data: fileBlob, error: downloadError } = await supabase.storage.from("btp-documents").download(photo.storage_path);
    if (downloadError || !fileBlob) return { ...photo, dataUrl: null };
    try {
      const buffer = Buffer.from(await fileBlob.arrayBuffer());
      const jpegBuffer = await sharp(buffer, { failOn: "none" }).rotate().jpeg({ quality: 85 }).toBuffer();
      return { ...photo, dataUrl: `data:image/jpeg;base64,${jpegBuffer.toString("base64")}` };
    } catch (conversionError) {
      console.error("[analyze-report-photos] conversion failed", photo.storage_path, conversionError);
      return { ...photo, dataUrl: null };
    }
  }));
  const usableImages = convertedImages.filter((photo): photo is typeof photo & { dataUrl: string } => Boolean(photo.dataUrl));
  const skippedCount = convertedImages.length - usableImages.length;
  if (!usableImages.length) return NextResponse.json({ error: "Aucune des photos de ce rapport n'a pu être lue (format non pris en charge ou fichier corrompu)." }, { status: 502 });

  const declaredText = (usages ?? []).length
    ? (usages ?? []).map((usage) => {
        const materialRow = usage.project_materials as unknown as { designation?: string } | { designation?: string }[] | null;
        const designation = Array.isArray(materialRow) ? materialRow[0]?.designation : materialRow?.designation;
        return `- ${designation || "Matériau"} : ${usage.quantity} ${usage.unit}`;
      }).join("\n")
    : "Aucune consommation de matériau déclarée pour ce rapport.";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      store: false,
      instructions: [
        "Tu assistes un administrateur de chantier BTP à Madagascar dans un contrôle de cohérence quantité/photo.",
        "Ta tâche n'est PAS de décrire la photo. Ta tâche est d'ESTIMER, uniquement à partir de ce qui est visible (surface, volume, épaisseur, nombre d'éléments, avancement des travaux), la quantité de matériau que ce travail visible aurait dû consommer, puis de COMPARER cette estimation à la quantité déclarée dans le rapport.",
        "Exemple de raisonnement attendu : si le rapport déclare 20 sacs de ciment mais que la photo ne montre qu'une petite dalle d'environ 1 m² sur 10 cm d'épaisseur, c'est un écart important (une telle dalle ne consomme qu'une fraction d'un sac) — à signaler clairement comme incohérent.",
        "Si l'estimation visuelle est du même ordre de grandeur que la quantité déclarée, conclus que la consommation est approximativement raisonnable (verdict coherent).",
        "Si l'écart est important et évident (ordre de grandeur différent), verdict incoherent — ce sera signalé en rouge à l'administrateur, donc ne l'utilise que pour un écart réellement flagrant, pas pour un doute mineur.",
        "Si tu ne peux pas juger correctement (photo trop floue, angle inexploitable, aucun élément mesurable visible), verdict incertain plutôt que de deviner.",
        "Reste prudent : il s'agit d'une estimation visuelle approximative, jamais d'une certitude. N'invente pas de détails non visibles sur les photos.",
        "Le champ confidence est un entier de 0 à 100 (pourcentage) représentant ta confiance dans cette estimation — jamais un nombre décimal entre 0 et 1.",
        "Réponds en français, de façon concise et exploitable par un administrateur pressé.",
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Matériaux déclarés utilisés ce jour (à comparer à ce qui est visuellement estimable sur les photos) :\n${declaredText}` },
            ...usableImages.map((photo) => ({ type: "input_image" as const, image_url: photo.dataUrl })),
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "report_photo_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              verdict: { type: "string", enum: ["coherent", "incertain", "incoherent"], description: "coherent = consommation approximativement raisonnable ; incoherent = écart important et évident ; incertain = impossible à juger visuellement." },
              confidence: { type: "number", description: "Entier de 0 à 100 représentant un pourcentage. Jamais une fraction entre 0 et 1." },
              summary: { type: "string", description: "Résumé de la comparaison quantité déclarée vs quantité estimée visuellement, pas une description de la photo." },
              observations: { type: "array", items: { type: "string" } },
            },
            required: ["verdict", "confidence", "summary", "observations"],
          },
        },
      },
    }),
  });

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("OpenAI report photo analysis failed", aiResponse.status, details);
    return NextResponse.json({ error: "L'analyse IA a échoué." }, { status: 502 });
  }

  const responsePayload = await aiResponse.json();
  const outputText = extractResponseText(responsePayload);
  if (!outputText) return NextResponse.json({ error: "Aucune analyse exploitable n'a été produite." }, { status: 502 });

  let parsed: { verdict: string; confidence: number; summary: string; observations: string[] };
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return NextResponse.json({ error: "Réponse d'analyse invalide." }, { status: 502 });
  }

  return NextResponse.json({ analysis: parsed, photosAnalyzed: usableImages.length, photosSkipped: skippedCount });
}
