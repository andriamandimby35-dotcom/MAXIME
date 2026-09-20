import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

// La lecture d'une photo ou d'un PDF de CIN (recto/verso) reste rapide (une
// seule petite image ou un tout petit PDF, jamais un DAO entier) : pas besoin
// de la même limite de 300s que /api/analyze-dao, mais on garde une marge
// confortable au cas où le moteur IA répond lentement.
export const maxDuration = 120;

const cinSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    full_name: { type: "string" },
    cin_number: { type: "string" },
    address: { type: "string" },
  },
  required: ["full_name", "cin_number", "address"],
};

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

// Lit automatiquement (dès l'ajout côté client, voir insertCinFile dans
// SubmissionDossierManager.tsx) une photo ou un PDF de CIN déjà déposé dans le
// stockage Supabase, pour préremplir nom/n° CIN/adresse d'un personnel de la
// liste utilisée pour générer son contrat individuel de travail. Le fichier
// reste conservé (jamais supprimé ici) : il sera joint tel quel en pages
// supplémentaires à la fin du contrat PDF généré (voir
// appendExternalFileAsPages et printable-submission-document/route.ts).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const supabase = await createServerClient();
    const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
      || request.headers.get("x-supabase-access-token") || "";
    const { data: { user } } = await supabase.auth.getUser(accessToken);
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

    const { data: member } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

    const { data: tender } = await supabase.from("tenders").select("id").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
    if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });

    const body = await request.json().catch(() => null) as { path?: string } | null;
    const path = body?.path?.trim();
    // Sécurité : le chemin doit obligatoirement appartenir à l'organisation ET
    // au DAO de l'utilisateur — jamais un chemin arbitraire envoyé par le
    // client (voir la même convention de chemin utilisée côté client dans
    // insertCinFile : `${organizationId}/submission/${tenderId}/cin/...`).
    if (!path || !path.startsWith(`${member.organization_id}/submission/${id}/cin/`)) {
      return NextResponse.json({ error: "Fichier CIN introuvable ou non autorisé." }, { status: 403 });
    }

    const signed = await supabase.storage.from("btp-documents").createSignedUrl(path, 300);
    if (signed.error || !signed.data?.signedUrl) {
      return NextResponse.json({ error: "Impossible de retrouver le fichier CIN enregistré." }, { status: 404 });
    }
    const fileResponse = await fetch(signed.data.signedUrl);
    if (!fileResponse.ok) return NextResponse.json({ error: "Le fichier CIN est inaccessible." }, { status: 502 });
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    const mimeType = fileResponse.headers.get("content-type") || (path.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });
    // Même garde-fou que /api/analyze-dao : ignorer une variable mal
    // configurée plutôt que d'envoyer une clé secrète comme nom de modèle.
    const rawModel = process.env.OPENAI_DAO_MODEL;
    const model = rawModel && !rawModel.startsWith("sk-") ? rawModel : "gpt-5.4-mini";

    const isPdf = mimeType.includes("pdf") || path.toLowerCase().endsWith(".pdf");
    let uploadedFileId: string | null = null;
    let visionContent: Record<string, unknown>;

    if (isPdf) {
      const uploadForm = new FormData();
      uploadForm.append("purpose", "user_data");
      uploadForm.append("file", new Blob([new Uint8Array(fileBuffer)], { type: "application/pdf" }), "cin.pdf");
      const uploadResponse = await fetch("https://api.openai.com/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: uploadForm,
      });
      if (!uploadResponse.ok) {
        const details = await uploadResponse.text();
        console.error("OpenAI CIN file upload failed", uploadResponse.status, details);
        return NextResponse.json({ error: "Le fichier CIN n'a pas pu être envoyé au moteur IA." }, { status: 502 });
      }
      const uploadedFile = await uploadResponse.json() as { id?: string };
      if (!uploadedFile.id) return NextResponse.json({ error: "Identifiant du fichier CIN indisponible." }, { status: 502 });
      uploadedFileId = uploadedFile.id;
      visionContent = { type: "input_file", file_id: uploadedFile.id };
    } else {
      const base64 = fileBuffer.toString("base64");
      visionContent = { type: "input_image", image_url: `data:${mimeType};base64,${base64}` };
    }

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
        instructions: [
          "Tu lis une carte d'identité nationale (CIN) malgache fournie en photo ou en PDF, parfois avec le recto et le verso visibles sur des pages ou zones différentes du même fichier.",
          "Extrais uniquement les informations réellement lisibles sur ce document précis : ne devine et n'invente jamais une valeur absente ou illisible.",
          "full_name doit contenir le nom complet (nom et prénoms) exactement comme imprimé sur la CIN.",
          "cin_number doit contenir le numéro de CIN exactement comme imprimé.",
          "address doit contenir l'adresse ou le lieu de résidence indiqué sur la CIN, s'il y figure.",
          "Si une information est absente, illisible, ou si le fichier fourni n'est manifestement pas une CIN, renvoie une chaîne vide pour ce champ plutôt que d'inventer une valeur.",
        ].join(" "),
        input: [{
          role: "user",
          content: [
            visionContent,
            { type: "input_text", text: "Lis cette carte d'identité et extrais les informations demandées." },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "cin_extraction",
            strict: true,
            schema: cinSchema,
          },
        },
      }),
    });

    if (uploadedFileId) {
      void fetch(`https://api.openai.com/v1/files/${uploadedFileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    }

    if (!aiResponse.ok) {
      const details = await aiResponse.text();
      console.error("OpenAI CIN extraction failed", aiResponse.status, details);
      return NextResponse.json({ error: "La lecture automatique de la CIN a échoué. Complétez les champs à la main." }, { status: 502 });
    }

    const aiPayload = await aiResponse.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const outputText = extractResponseText(aiPayload);
    if (!outputText) return NextResponse.json({ error: "Réponse IA vide." }, { status: 502 });

    let structured: { full_name: string; cin_number: string; address: string };
    try { structured = JSON.parse(outputText) as { full_name: string; cin_number: string; address: string }; }
    catch { return NextResponse.json({ error: "Réponse IA illisible." }, { status: 502 }); }

    return NextResponse.json({
      full_name: structured.full_name || "",
      cin_number: structured.cin_number || "",
      address: structured.address || "",
    });
  } catch (error) {
    console.error("extract-cin failed", error);
    return NextResponse.json({ error: "Lecture de la CIN impossible." }, { status: 500 });
  }
}
