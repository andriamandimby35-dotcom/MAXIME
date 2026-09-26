import fs from "fs";
import path from "path";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

// Police unique utilisée par TOUS les PDF générés par l'application. Les
// polices standards de pdf-lib (Helvetica) se limitent à l'encodage WinAnsi
// et affichaient un "?" pour beaucoup de caractères pourtant courants (œ,
// certains signes typographiques, lettres de langues étrangères...).
// DejaVu Sans est une police libre avec une couverture Unicode bien plus
// large qui règle ce problème pour la quasi-totalité des cas réels.
//
// Les fichiers sont dans /public/fonts (et non /lib) pour être copiés tels
// quels par le build Docker "standalone" — voir Dockerfile :
// `COPY --from=builder /app/public ./public` — qui ne dépend donc jamais du
// traçage de fichiers de Next.js (fragile pour un fs.readFileSync).
let cachedRegular: Uint8Array | null = null;
let cachedBold: Uint8Array | null = null;

function readFontFile(fileName: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(process.cwd(), "public", "fonts", fileName)));
}

export async function embedUnicodeFonts(doc: PDFDocument, options: { subset?: boolean } = {}): Promise<{ font: PDFFont; boldFont: PDFFont }> {
  // subset=false (utilisé pour un PDF avec de VRAIES cases à remplir
  // cliquables, voir createFillableDaoTemplatePdf) : une police "subset"
  // n'embarque que les caractères déjà utilisés ailleurs dans CE document
  // (résumé, valeurs préremplies...). Pour une case encore vide, l'utilisateur
  // tape ensuite N'IMPORTE quel caractère dans SA PROPRE application PDF
  // (accents, chiffres, symboles jamais utilisés ailleurs dans ce fichier) :
  // embarquer la police complète évite qu'un caractère tapé plus tard
  // s'affiche vide ou en tofu faute d'exister dans le sous-ensemble embarqué
  // au moment de la génération.
  doc.registerFontkit(fontkit);
  cachedRegular ??= readFontFile("DejaVuSans.ttf");
  cachedBold ??= readFontFile("DejaVuSans-Bold.ttf");
  const subset = options.subset ?? true;
  const font = await doc.embedFont(cachedRegular, { subset });
  const boldFont = await doc.embedFont(cachedBold, { subset });
  return { font, boldFont };
}
