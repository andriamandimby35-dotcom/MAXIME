import { NextResponse } from "next/server";
import sharp from "sharp";
import { createServerClient } from "@/lib/supabase/server";

// Même convertisseur que analyze-report-photos/route.ts : le modèle IA
// n'accepte que jpeg/png/gif/webp, alors qu'une photo de téléphone peut être
// dans un format qu'il ne lit pas (HEIC...). On convertit toujours en JPEG.
async function toJpegDataUrl(buffer: Buffer) {
  const jpegBuffer = await sharp(buffer, { failOn: "none" }).rotate().jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`;
}

function extractResponseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

// Vérifie, à partir de la photo prise au moment d'un achat de matériaux, que
// le matériau visible correspond (ou est équivalent) au matériau déclaré et
// estime le nombre d'unités visibles, pour comparaison avec la quantité
// achetée déclarée. Cette route ne touche JAMAIS la base de données : elle
// rend seulement un verdict, que le client (ProjectSiteManager.tsx) utilise
// pour décider de bloquer ou non la validation de l'achat — voir
// performPurchaseValidation/uploadPurchaseEvidence pour la suite.
//
// Toute panne technique (clé API absente, appel IA en échec, quota/crédit
// épuisé, réponse illisible) répond avec { error } et un statut non-2xx :
// le client doit alors considérer la vérification comme simplement
// INDISPONIBLE (avertir sans bloquer), jamais comme une preuve d'incohérence
// — seul un verdict "non_conforme" réellement rendu par l'IA doit bloquer.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project } = await supabase.from("projects").select("id, organization_id").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  // Vérification volontairement ouverte à tout membre actif de l'organisation
  // (pas réservée aux administrateurs) : c'est la même personne qui a
  // l'autorisation "Photos" pour valider l'achat qui déclenche cette
  // vérification ; l'écriture réelle en base reste de toute façon protégée
  // par les règles RLS habituelles, cette route ne fait qu'analyser la photo.
  if (!member?.active) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  const materialName = String(form?.get("material_name") || "").trim();
  const unit = String(form?.get("unit") || "").trim();
  const declaredQuantity = Number(form?.get("declared_quantity"));
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Photo manquante." }, { status: 400 });
  if (!materialName || !Number.isFinite(declaredQuantity) || declaredQuantity <= 0) {
    return NextResponse.json({ error: "Matériau ou quantité déclarée manquant." }, { status: 400 });
  }

  let dataUrl: string;
  try {
    dataUrl = await toJpegDataUrl(Buffer.from(await file.arrayBuffer()));
  } catch (conversionError) {
    console.error("[verify-purchase-photo] conversion failed", conversionError);
    return NextResponse.json({ error: "Photo illisible (format non pris en charge ou fichier corrompu)." }, { status: 502 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

  let aiResponse: Response;
  try {
    aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
        store: false,
        instructions: [
          "Tu assistes un administrateur de chantier BTP à Madagascar à vérifier un achat de matériau à partir d'une photo prise au moment de la livraison ou de l'achat.",
          `Le matériau déclaré est : "${materialName}"${unit ? ` (unité : ${unit})` : ""}. La quantité déclarée achetée est : ${declaredQuantity}${unit ? ` ${unit}` : ""}.`,
          "Vérifie d'abord si ce qui est visible sur la photo correspond bien à ce matériau, ou à un équivalent raisonnable (ex. une marque différente du même produit, un conditionnement différent du même matériau) : material_match=conforme. Si la photo montre manifestement un AUTRE matériau, sans rapport avec celui déclaré : material_match=non_conforme. Si tu ne peux pas identifier avec certitude le matériau visible (photo floue, trop éloignée, emballage non identifiable) : material_match=indetermine — ne devine jamais.",
          "Estime ensuite, uniquement à partir de ce qui est concrètement comptable sur la photo (sacs, unités, éléments empilés, longueur visible d'une barre...), le nombre d'unités visibles dans estimated_quantity. Si un comptage fiable est impossible (tas en vrac impossible à dénombrer, photo trop partielle, angle inexploitable), utilise estimated_quantity=null plutôt que d'inventer un nombre.",
          "Compare ensuite ce nombre estimé à la quantité déclarée : si c'est le même ordre de grandeur (une estimation visuelle reste approximative, une petite différence est normale), quantity_match=conforme. Si l'écart est flagrant et important (par exemple 5 sacs visibles contre 50 sacs déclarés), quantity_match=non_conforme — réserve ce verdict aux écarts réellement évidents, pas à un doute mineur. Si estimated_quantity est null, quantity_match=indetermine.",
          "notes résume en une phrase ce que tu vois et pourquoi, utile à un administrateur pressé. Réponds en français.",
        ].join(" "),
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "Voici la photo prise au moment de cet achat de matériau." },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "purchase_photo_verification",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                material_match: { type: "string", enum: ["conforme", "non_conforme", "indetermine"] },
                estimated_quantity: { type: ["number", "null"] },
                quantity_match: { type: "string", enum: ["conforme", "non_conforme", "indetermine"] },
                notes: { type: "string" },
              },
              required: ["material_match", "estimated_quantity", "quantity_match", "notes"],
            },
          },
        },
      }),
    });
  } catch (networkError) {
    console.error("[verify-purchase-photo] OpenAI request failed", networkError);
    return NextResponse.json({ error: "Le moteur IA est injoignable pour le moment." }, { status: 502 });
  }

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("[verify-purchase-photo] OpenAI verification failed", aiResponse.status, details);
    return NextResponse.json({ error: "La vérification IA a échoué." }, { status: 502 });
  }

  const responsePayload = await aiResponse.json().catch(() => null);
  const outputText = responsePayload ? extractResponseText(responsePayload) : "";
  if (!outputText) return NextResponse.json({ error: "Aucune vérification exploitable n'a été produite." }, { status: 502 });

  let parsed: { material_match: "conforme" | "non_conforme" | "indetermine"; estimated_quantity: number | null; quantity_match: "conforme" | "non_conforme" | "indetermine"; notes: string };
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return NextResponse.json({ error: "Réponse de vérification invalide." }, { status: 502 });
  }

  return NextResponse.json(parsed);
}
