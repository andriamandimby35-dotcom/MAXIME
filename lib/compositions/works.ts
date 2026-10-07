import { canonicalMaterialKey, canonicalUnit } from "@/lib/material-normalization";
import { stripLineReference } from "@/lib/prices/synonyms";

// Compositions standard des ouvrages courants : un ouvrage (enduit, béton,
// maçonnerie…) est décomposé en MATÉRIAUX (ciment + sable + eau…), la
// main-d'œuvre n'est pas comptée (déjà dans les salaires journaliers).
// Utilisé par TOUS les devis : devis du DAO (composants proposés) et devis
// ajoutés par PDF (calcul automatique du prix interne).
//
// Règles quand le devis ne précise rien :
// - dosage : le plus bas (250 kg/m³) ;
// - épaisseur d'un parpaing : standard 15 cm ; brique : standard 11 cm ;
// - épaisseur d'un enduit / crépi / chape : 2 / 1,5 / 4 cm.

export type MatchSpec = { all: string[]; any?: string[]; exclude?: string[] };

export type CompositionComponent = {
  /** Nom affiché (et enregistré dans la bibliothèque). */
  designation: string;
  /** Nom simple utilisé pour la recherche internet. */
  search: string;
  unit: string;
  quantity: number;
  note: string;
  /** Composant facultatif : s'il n'a pas de prix, il compte 0 sans bloquer le calcul. */
  optional?: boolean;
  match: MatchSpec;
};

export type WorkComposition = {
  ruleId: string;
  title: string;
  components: CompositionComponent[];
  notes: string[];
  dosage: number | null;
  thicknessCm: number | null;
};

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

const CEMENT: MatchSpec = { all: ["ciment"], exclude: ["colle", "blanc", "joint", "peinture", "adhesif", "refractaire", "fondu", "carrelage", "hydrofuge", "enduit"] };
const SAND: MatchSpec = { all: ["sable"], exclude: ["silice", "colore", "quartz"] };
const GRAVEL: MatchSpec = { all: [], any: ["gravillon", "gravier"], exclude: [] };
const WATER: MatchSpec = { all: ["eau"], exclude: [] };

function ascii(text: string) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/³/g, "3").replace(/²/g, "2");
}

/** Dosage en kg/m³ indiqué dans la désignation (Q350, dosé à 350 kg/m3…), sinon null. */
export function parseDosage(designation: string): number | null {
  const text = ascii(designation);
  const found = text.match(/\bq\s?(\d{3})\b/)?.[1]
    ?? text.match(/\b(\d{3})\s?kg\s*(?:\/|par)?\s*m\s?3\b/)?.[1]
    ?? text.match(/\bdos\w*\s*(?:a|de|:)?\s*(\d{3})\b/)?.[1];
  const value = Number(found);
  return Number.isFinite(value) && value >= 150 && value <= 600 ? value : null;
}

/** Épaisseur en cm indiquée dans la désignation (ép. 2 cm, épaisseur 15 cm, 15x20x40…), sinon null. */
export function parseThicknessCm(designation: string): number | null {
  const text = ascii(designation).replace(/,/g, ".");
  const labelled = text.match(/(?:\bepaisseur|\bep\.?|\be\s*=)\s*:?\s*(?:de\s+)?(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/);
  if (labelled) {
    const value = Number(labelled[1]);
    return labelled[2] === "mm" ? value / 10 : labelled[2] === "m" ? value * 100 : value;
  }
  const dims = text.match(/\b(\d{2})\s*[x×]\s*\d{2}\s*[x×]\s*\d{2}\b/)?.[1];
  if (dims) return Number(dims);
  const plain = text.match(/\b(\d+(?:\.\d+)?)\s*cm\b/)?.[1];
  return plain ? Number(plain) : null;
}

type Rule = {
  id: string;
  title: string;
  units: string[];
  keywords: string[];
  exclude?: string[];
  build: (key: string, designation: string) => Omit<WorkComposition, "ruleId" | "title">;
};

function dosageInfo(designation: string) {
  const stated = parseDosage(designation);
  const dosage = stated ?? 250;
  return { dosage, note: stated ? `Dosage indiqué : ${stated} kg/m³.` : "Dosage non indiqué : on prend le plus bas (250 kg/m³)." };
}

// Mortier d'un ouvrage de surface (m²) : volume = épaisseur × 1,10 (pertes).
function mortarSurface(title: string, defaultThickness: number): Rule["build"] {
  return (_key, designation) => {
    const { dosage, note } = dosageInfo(designation);
    const statedThickness = parseThicknessCm(designation);
    const plausible = statedThickness !== null && statedThickness >= 0.5 && statedThickness <= 10;
    const thickness = plausible ? (statedThickness as number) : defaultThickness;
    const volume = (thickness / 100) * 1.1;
    return {
      dosage,
      thicknessCm: thickness,
      notes: [note, plausible ? `Épaisseur indiquée : ${thickness} cm.` : `Épaisseur non indiquée : ${thickness} cm (${title}).`],
      components: [
        { designation: "Ciment pour mortier", search: "Ciment", unit: "kg", quantity: round(dosage * volume), note: `${dosage} kg de ciment par m³ de mortier.`, match: CEMENT },
        { designation: "Sable pour mortier", search: "Sable", unit: "m3", quantity: round(volume), note: "1 m³ de sable par m³ de mortier.", match: SAND },
        { designation: "Eau", search: "Eau", unit: "L", quantity: round(dosage * volume * 0.5, 2), note: "Environ 0,5 L d'eau par kg de ciment.", optional: true, match: WATER },
      ],
    };
  };
}

const MASONRY_JOINT_VOLUME: Record<number, number> = { 10: 0.007, 15: 0.011, 20: 0.015 };

// « parpaing de 10 », « parpaings creux 15 » : épaisseur écrite sans « cm ».
function bareThickness(designation: string, words: string, values: string) {
  const match = ascii(designation).match(new RegExp(`(?:${words})\\w*(?:\\s+\\w+)?\\s+(?:de\\s+)?(${values})\\b`));
  return match ? Number(match[1]) : null;
}

function pickThickness(stated: number | null, variants: number[], standard: number) {
  if (stated === null) return { value: standard, stated: false };
  const nearest = variants.reduce((best, value) => (Math.abs(value - stated) < Math.abs(best - stated) ? value : best), variants[0]);
  return { value: nearest, stated: true };
}

const RULES: Rule[] = [
  {
    id: "beton", title: "Béton", units: ["m3"], keywords: ["beton"], exclude: ["coffrage"],
    build: (_key, designation) => {
      const { dosage, note } = dosageInfo(designation);
      const notes = [note];
      if (/\barm[ée]/i.test(designation)) notes.push("Les armatures (fers) ne sont pas comptées : ajoute-les si le prix du m³ les comprend.");
      return {
        dosage, thicknessCm: null, notes,
        components: [
          { designation: `Ciment (${dosage} kg/m³)`, search: "Ciment", unit: "kg", quantity: dosage, note: "Dosage à vérifier selon le DAO, le CCTP ou le BET.", match: CEMENT },
          { designation: "Sable", search: "Sable", unit: "m3", quantity: 0.45, note: "Quantité indicative par m³, modifiable.", match: SAND },
          { designation: "Gravillon", search: "Gravillon", unit: "m3", quantity: 0.85, note: "Quantité indicative par m³, modifiable.", match: GRAVEL },
          { designation: "Eau ou adjuvant", search: "Eau", unit: "L", quantity: 175, note: "À conserver uniquement si facturé séparément.", optional: true, match: WATER },
        ],
      };
    },
  },
  { id: "enduit", title: "Enduit au mortier de ciment", units: ["m2"], keywords: ["enduit"], exclude: ["peinture", "platre", "lissage", "colle"], build: mortarSurface("enduit", 2) },
  { id: "crepi", title: "Crépi au mortier de ciment", units: ["m2"], keywords: ["crepi"], exclude: ["peinture"], build: mortarSurface("crépi", 1.5) },
  { id: "chape", title: "Chape au mortier de ciment", units: ["m2"], keywords: ["chape", "chappe", "ragreage"], build: mortarSurface("chape", 4) },
  {
    id: "parpaing", title: "Maçonnerie de parpaings", units: ["m2"], keywords: ["parpaing", "agglo", "bloc creux", "bloc de beton", "blocs de beton", "bloc en beton", "blocs en beton", "bloc beton"],
    build: (_key, designation) => {
      const picked = pickThickness(parseThicknessCm(designation) ?? bareThickness(designation, "parpaing|agglo|bloc", "10|15|20"), [10, 15, 20], 15);
      const thickness = picked.value;
      const volume = MASONRY_JOINT_VOLUME[thickness] ?? 0.011;
      return {
        dosage: 250, thicknessCm: thickness,
        notes: [picked.stated ? `Épaisseur du parpaing indiquée : ${thickness} cm.` : "Épaisseur du parpaing non indiquée : standard 15 cm.", "Joints au mortier dosé à 250 kg/m³ (le plus bas)."],
        components: [
          { designation: `Parpaing ${thickness}`, search: `Parpaing ${thickness} cm`, unit: "u", quantity: 12.5, note: "Environ 12,5 parpaings par m² (pertes comprises).", match: { all: ["parpaing", String(thickness)], exclude: [] } },
          { designation: "Ciment pour mortier", search: "Ciment", unit: "kg", quantity: round(250 * volume), note: "Mortier des joints.", match: CEMENT },
          { designation: "Sable pour mortier", search: "Sable", unit: "m3", quantity: round(volume), note: "Mortier des joints.", match: SAND },
          { designation: "Eau", search: "Eau", unit: "L", quantity: round(250 * volume * 0.5, 2), note: "Environ 0,5 L d'eau par kg de ciment.", optional: true, match: WATER },
        ],
      };
    },
  },
  {
    id: "brique", title: "Maçonnerie de briques", units: ["m2"], keywords: ["brique"], exclude: ["refractaire"],
    build: (_key, designation) => {
      const picked = pickThickness(parseThicknessCm(designation) ?? bareThickness(designation, "brique", "11|22"), [11, 22], 11);
      const thickness = picked.value;
      const count = thickness === 22 ? 130 : 65;
      const volume = thickness === 22 ? 0.05 : 0.025;
      return {
        dosage: 250, thicknessCm: thickness,
        notes: [picked.stated ? `Épaisseur du mur indiquée : ${thickness} cm.` : "Épaisseur non indiquée : brique standard, mur de 11 cm.", "Joints au mortier dosé à 250 kg/m³ (le plus bas)."],
        components: [
          { designation: "Brique pleine", search: "Brique pleine", unit: "u", quantity: count, note: `Environ ${count} briques par m² (pertes comprises).`, match: { all: ["brique"], exclude: ["refractaire"] } },
          { designation: "Ciment pour mortier", search: "Ciment", unit: "kg", quantity: round(250 * volume), note: "Mortier des joints.", match: CEMENT },
          { designation: "Sable pour mortier", search: "Sable", unit: "m3", quantity: round(volume), note: "Mortier des joints.", match: SAND },
          { designation: "Eau", search: "Eau", unit: "L", quantity: round(250 * volume * 0.5, 2), note: "Environ 0,5 L d'eau par kg de ciment.", optional: true, match: WATER },
        ],
      };
    },
  },
  {
    id: "moellon", title: "Maçonnerie de moellons", units: ["m3"], keywords: ["moellon"], exclude: ["main d", "depose", "demolition"],
    build: () => ({
      dosage: 250, thicknessCm: null,
      notes: ["Environ 1,2 m³ de moellons par m³ de maçonnerie (pertes comprises) et 0,3 m³ de mortier dosé à 250 kg/m³ (le plus bas)."],
      components: [
        { designation: "Moellons de pierre", search: "Moellons de pierre", unit: "m3", quantity: 1.2, note: "Pertes et vides compris.", match: { all: ["moellon"], exclude: ["main", "pose"] } },
        { designation: "Ciment pour mortier", search: "Ciment", unit: "kg", quantity: 75, note: "0,3 m³ de mortier par m³ de maçonnerie.", match: CEMENT },
        { designation: "Sable pour mortier", search: "Sable", unit: "m3", quantity: 0.3, note: "0,3 m³ de mortier par m³ de maçonnerie.", match: SAND },
        { designation: "Eau", search: "Eau", unit: "L", quantity: 38, note: "Environ 0,5 L d'eau par kg de ciment.", optional: true, match: WATER },
      ],
    }),
  },
  {
    id: "carrelage", title: "Carrelage ou faïence collé", units: ["m2"], keywords: ["carrelage", "carreau", "faience", "gres cerame", "granito"],
    exclude: ["depose", "demolition", "plinthe", "peinture", "reparation", "remplacement", "nez de marche"],
    build: (key, designation) => {
      const size = ascii(designation).match(/\b(\d{2})\s*[x×]\s*(\d{2})\b/);
      const sized = size ? [`${size[1]}`, `${size[2]}`] : [];
      const wall = /faience|murale?|mur\b/.test(key);
      const outside = /exterieur/.test(key);
      return {
        dosage: null, thicknessCm: null,
        notes: ["Carreaux posés à la colle : 1,05 m² de carreaux par m² (pertes), 5 kg de colle et 0,4 kg de joint par m². La chape ou le support est un autre poste du devis."],
        components: [
          { designation: wall ? "Faïence murale" : "Carreau de sol", search: wall ? "Faïence murale" : "Carrelage sol", unit: "m2", quantity: 1.05, note: "Pertes de coupe comprises.", match: wall ? { all: ["faience", ...sized.slice(0, 1)], exclude: [] } : { all: [...sized.slice(0, 1)], any: ["carreau", "carrelage", "granito"], exclude: ["colle", "plinthe", "joint", "croisillon", "primaire", "nez", "faience", "enduit"] } },
          { designation: "Colle à carrelage (sac de 25 kg)", search: "Colle à carrelage", unit: "u", quantity: 0.2, note: "Environ 5 kg de colle par m².", match: { all: ["colle", "carrelage"], exclude: outside ? ["pvc"] : ["pvc", "flexible", "exterieure"] } },
          { designation: "Joint de carrelage (sac de 5 kg)", search: "Joint de carrelage", unit: "u", quantity: 0.08, note: "Environ 0,4 kg de joint par m².", optional: true, match: { all: ["joint", "carrelage"], exclude: [] } },
        ],
      };
    },
  },
  {
    id: "coffrage", title: "Coffrage en bois", units: ["m2"], keywords: ["coffrage"], exclude: ["huile", "beton arme", "demolition", "depose"],
    build: () => ({
      dosage: null, thicknessCm: null,
      notes: ["Bois réutilisé environ 3 fois : 0,4 planche, 0,5 tasseau, 0,1 kg de pointes et 0,1 L d'huile de décoffrage par m² de coffrage."],
      components: [
        { designation: "Planche de coffrage 25x200 (4 m)", search: "Planche de coffrage", unit: "u", quantity: 0.4, note: "Planche de 1 m² de surface, réutilisée environ 3 fois.", match: { all: ["planche", "coffrage"], exclude: [] } },
        { designation: "Tasseau 30x40 (4 m)", search: "Tasseau", unit: "u", quantity: 0.5, note: "Raidisseurs.", match: { all: ["tasseau"], exclude: [] } },
        { designation: "Pointes (au kg)", search: "Pointes", unit: "kg", quantity: 0.1, note: "Clouage du coffrage.", optional: true, match: { all: ["pointe"], exclude: [] } },
        { designation: "Huile de décoffrage", search: "Huile de décoffrage", unit: "L", quantity: 0.1, note: "Environ 0,1 L par m².", optional: true, match: { all: ["huile", "coffrage"], exclude: [] } },
      ],
    }),
  },
  {
    id: "acier", title: "Armatures en acier", units: ["kg"], keywords: ["armature", "ferraillage", "acier", "fer a beton", "fer ha", "fers ha", "ha 8", "ha8", "ha 10", "ha10", "ha12", "ha 12"],
    exclude: ["inox", "plat ", "cornière", "corniere", "tole", "charpente", "demolition", "depose", "grille", "porte", "fenetre", "portail"],
    build: (_key, designation) => {
      const diameter = ascii(designation).match(/\bha\s?(\d{1,2})\b/)?.[1] ?? ascii(designation).match(/(?:ø|\bd|\bdiam\w*)\s?(\d{1,2})\b/)?.[1] ?? null;
      return {
        dosage: null, thicknessCm: null,
        notes: ["Acier à béton : 1,05 kg par kg posé (chutes et recouvrements). Le fil de ligature est compté à part s'il est facturé."],
        components: [
          { designation: diameter ? `Acier HA${diameter} (au kg)` : "Acier à béton HA (au kg)", search: diameter ? `Acier HA${diameter}` : "Acier HA", unit: "kg", quantity: 1.05, note: "Chutes et recouvrements compris.", match: { all: ["acier", ...(diameter ? [`ha${diameter}`] : [])], exclude: ["inox"] } },
        ],
      };
    },
  },
  {
    id: "remblai", title: "Remblai", units: ["m3"], keywords: ["remblai"], exclude: ["demolition", "depose", "evacuation", "deblai", "provenance"],
    build: (key) => {
      const sand = key.includes("sable");
      const topsoil = key.includes("tout venant");
      return {
        dosage: null, thicknessCm: null,
        notes: ["1,2 m³ de matériau livré par m³ de remblai compacté (foisonnement)."],
        components: [
          sand
            ? { designation: "Sable de remblai", search: "Sable de remblai", unit: "m3", quantity: 1.2, note: "Foisonnement compris.", match: { all: ["sable", "remblai"], exclude: [] } }
            : topsoil
              ? { designation: "Tout-venant", search: "Tout-venant", unit: "m3", quantity: 1.2, note: "Foisonnement compris.", match: { all: ["tout", "venant"], exclude: [] } }
              : { designation: "Latérite pour remblai", search: "Latérite pour remblai", unit: "m3", quantity: 1.2, note: "Foisonnement compris.", match: { all: ["laterite"], exclude: [] } },
        ],
      };
    },
  },
  {
    id: "herissonnage", title: "Hérissonnage en pierre sèche", units: ["m3"], keywords: ["herissonnage", "herisson"], exclude: ["demolition", "depose"],
    build: () => ({
      dosage: null, thicknessCm: null,
      notes: ["1,25 m³ de pierres par m³ de hérissonnage (vides et pertes), un peu de sable pour caler."],
      components: [
        { designation: "Moellons ou pierres sèches", search: "Moellons de pierre", unit: "m3", quantity: 1.25, note: "Vides et pertes compris.", match: { all: ["moellon"], exclude: ["main", "pose"] } },
        { designation: "Sable de calage", search: "Sable", unit: "m3", quantity: 0.1, note: "Remplit les vides du dessus.", optional: true, match: SAND },
      ],
    }),
  },
  {
    id: "dallage", title: "Dallage en béton", units: ["m2"], keywords: ["dallage", "dalle en beton", "dalle beton"], exclude: ["demolition", "depose", "prefabrique", "preface", "gazon", "peinture", "coffrage"],
    build: (_key, designation) => {
      const { dosage, note } = dosageInfo(designation);
      const stated = parseThicknessCm(designation);
      const plausible = stated !== null && stated >= 4 && stated <= 30;
      const thickness = plausible ? (stated as number) : 10;
      const volume = (thickness / 100) * 1.05;
      return {
        dosage, thicknessCm: thickness,
        notes: [note, plausible ? `Épaisseur indiquée : ${thickness} cm.` : "Épaisseur non indiquée : 10 cm (dallage courant).", "Treillis et coffrage ne sont pas comptés : ajoute-les s'ils sont dans le prix."],
        components: [
          { designation: `Ciment (${dosage} kg/m³)`, search: "Ciment", unit: "kg", quantity: round(dosage * volume), note: "Béton du dallage, pertes comprises.", match: CEMENT },
          { designation: "Sable", search: "Sable", unit: "m3", quantity: round(0.45 * volume), note: "Quantité indicative par m³ de béton.", match: SAND },
          { designation: "Gravillon", search: "Gravillon", unit: "m3", quantity: round(0.85 * volume), note: "Quantité indicative par m³ de béton.", match: GRAVEL },
        ],
      };
    },
  },
];

/** Composition standard de l'ouvrage, ou null si l'ouvrage n'est pas (encore) connu. */
export function compositionFor(rawDesignation: string, unit: string): WorkComposition | null {
  const designation = stripLineReference(rawDesignation);
  const key = canonicalMaterialKey(designation);
  const targetUnit = canonicalUnit(unit);
  if (!key || !targetUnit) return null;
  let best: { rule: Rule; index: number } | null = null;
  for (const rule of RULES) {
    if (!rule.units.includes(targetUnit)) continue;
    if (rule.exclude?.some((word) => key.includes(word))) continue;
    const indexes = rule.keywords.map((word) => key.indexOf(word)).filter((index) => index >= 0);
    if (indexes.length === 0) continue;
    const index = Math.min(...indexes);
    if (!best || index < best.index) best = { rule, index };
  }
  if (!best) return null;
  const built = best.rule.build(key, designation);
  return { ruleId: best.rule.id, title: best.rule.title, ...built };
}

/** Composants au format du devis du DAO (composition proposée, prix à retrouver). */
export function compositeInputsFor(designation: string, unit: string) {
  const composition = compositionFor(designation, unit);
  if (!composition) return null;
  return composition.components.map((component) => ({
    designation: component.designation,
    unit: component.unit === "u" ? "U" : component.unit === "m3" ? "m³" : component.unit,
    quantity_per_work_unit: component.quantity,
    note: component.note,
    found_unit_price: null as number | null,
    source_url: "",
    supplier_name: "",
  }));
}
