/**
 * Contrôle des prix d'un devis (gratuit, aucun crédit IA, rien n'est modifié tout seul).
 * Module pur : reçoit les lignes du devis, ce que la bibliothèque donnerait aujourd'hui pour chacune,
 * et (si possible) les postes du DAO, puis renvoie la liste des anomalies à regarder.
 */

export type CheckLine = {
  index: number;
  position: number;          // numéro affiché dans la colonne N°
  designation: string;       // texte de la ligne
  unit: string;
  quantity: number;          // quantité enregistrée dans le devis (déjà multipliée pour un ouvrage répété)
  price: number;             // prix unitaire
  total: number;             // total enregistré
  provenance: string;
  status: string;
  code: string;
  section: string;
  multiplier: number;        // 1 si ouvrage non répété
  auto: boolean;             // prix repris automatiquement (bibliothèque / composition)
  internal: boolean;         // ligne interne hors DAO
  salary: boolean;           // ligne de salaire (main-d'œuvre interne)
  laborOnly: boolean;
  excluded: boolean;         // exclue par un choix (ex. parpaing au lieu de brique) ou désactivée
  groupHeader: boolean;      // ligne titre sans prix propre
  ack: string[];             // anomalies déjà acceptées par l'utilisateur
};

export type LibraryHit = { price: number; source: string; approximate?: boolean };

export type DaoItem = { section: string; code: string; designation: string; unit: string; quantity: number | null };

export type AlertLevel = "error" | "warn" | "info";

export type PriceAlert = {
  key: string;
  index: number | null;      // null = ligne absente du devis
  level: AlertLevel;
  kind: string;
  title: string;
  detail: string;
  signature: string;         // sert à mémoriser « garder mon prix »
  fix?: { price: number; source: string; totalOnly?: boolean };
};

const norm = (value: unknown) => String(value ?? "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function unitKey(value: string) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/³/g, "3").replace(/²/g, "2").replace(/[\s.\-_/]/g, "");
}

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const LEVEL_ORDER: Record<AlertLevel, number> = { error: 0, warn: 1, info: 2 };

export function buildPriceAlerts({ lines, hits, dao }: { lines: CheckLine[]; hits: Map<number, LibraryHit>; dao: DaoItem[] | null }): PriceAlert[] {
  const alerts: PriceAlert[] = [];
  const add = (line: CheckLine | null, kind: string, level: AlertLevel, title: string, detail: string, fix?: PriceAlert["fix"], keySuffix = "") => {
    const signature = line ? `${kind}|${Math.round(line.price * 100) / 100}|${Math.round(line.quantity * 1000) / 1000}${keySuffix}` : `${kind}${keySuffix}`;
    if (line && line.ack.includes(signature)) return;
    alerts.push({ key: `${kind}:${line ? line.index : "dao"}${keySuffix}`, index: line ? line.index : null, level, kind, title, detail, signature, fix });
  };

  const active = lines.filter((line) => !line.excluded && !line.groupHeader);
  const priced = active.filter((line) => line.price > 0 && !line.laborOnly);

  for (const line of active) {
    const hit = hits.get(line.index);

    // 1) Prix manquant
    if (line.price <= 0 && !line.laborOnly) {
      if (hit && hit.price > 0) {
        add(line, "missing", line.internal ? "info" : "warn", "Pas de prix, mais la bibliothèque en propose un",
          `${hit.approximate ? "Fiche voisine (à vérifier)" : "Bibliothèque"} : ${fmt(hit.price)} Ar / ${line.unit || "unité"}.`,
          { price: hit.price, source: hit.source });
      } else {
        add(line, "missing", line.internal ? "info" : "warn", "Ligne sans prix", "Aucun prix dans le devis ni dans la bibliothèque : à renseigner (ou chercher sur internet).");
      }
      continue;
    }
    if (line.price <= 0) continue;

    // 2) Total qui ne correspond pas à quantité × prix
    const expected = line.quantity * line.price;
    if (line.total > 0 && Math.abs(line.total - expected) > Math.max(1, expected * 0.005)) {
      add(line, "total", "warn", "Total incohérent avec quantité × prix",
        `Le total affiché est ${fmt(line.total)} Ar alors que ${line.quantity.toLocaleString("fr-FR")} × ${fmt(line.price)} = ${fmt(expected)} Ar.`,
        { price: line.price, source: line.provenance, totalOnly: true });
    }

    // 3) Prix périmé / très différent de la bibliothèque
    if (hit && hit.price > 0 && !line.salary && !line.laborOnly) {
      const ratio = line.price / hit.price;
      if (line.auto && !hit.approximate) {
        if (Math.abs(ratio - 1) > 0.03) {
          add(line, "stale", ratio > 1.5 || ratio < 1 / 1.5 ? "error" : "warn", "Prix différent de la bibliothèque actuelle",
            `Dans le devis : ${fmt(line.price)} Ar. La bibliothèque donne aujourd'hui ${fmt(hit.price)} Ar (${hit.source}).`,
            { price: hit.price, source: hit.source });
        }
      } else if (!line.auto && !hit.approximate && (ratio > 3 || ratio < 1 / 3)) {
        add(line, "far", "info", "Ton prix est très différent de la bibliothèque",
          `Dans le devis : ${fmt(line.price)} Ar. La bibliothèque donne ${fmt(hit.price)} Ar (${hit.source}). Garde ton prix s'il est voulu.`,
          { price: hit.price, source: hit.source });
      }
    }

    // 4) Prix approximatif d'une fiche voisine
    if (/^À vérifier/i.test(line.provenance)) {
      add(line, "approx", "info", "Prix pris sur une fiche voisine", `${line.provenance}. À confirmer avant d'envoyer le devis.`);
    }

    // 5) Ordres de grandeur absurdes selon l'unité
    const unit = unitKey(line.unit);
    const range = (() => {
      if (line.salary) return { min: 5000, max: 400000, label: "un salaire journalier" };
      if (line.laborOnly) return null;
      if (unit === "m3") return { min: 1000, max: 20000000, label: "un prix au m³" };
      if (unit === "ml" || unit === "m") return { min: 0, max: 150000, label: "un prix au mètre" };
      if (unit === "kg") return { min: 100, max: 60000, label: "un prix au kg" };
      if (unit === "m2") return { min: 0, max: 500000, label: "un prix au m²" };
      return null;
    })();
    if (range && (line.price < range.min || line.price > range.max)) {
      add(line, "absurd", "error", "Prix qui paraît incohérent pour cette unité",
        `${fmt(line.price)} Ar / ${line.unit} : ${range.label} entre ${fmt(range.min)} et ${fmt(range.max)} Ar est attendu.`);
    }
  }

  // 6) Même désignation + même unité mais prix très différents
  const groups = new Map<string, CheckLine[]>();
  for (const line of priced) {
    if (line.salary) continue;
    const key = `${norm(line.designation)}|${unitKey(line.unit)}`;
    if (!norm(line.designation)) continue;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mid = median(group.map((line) => line.price));
    for (const line of group) {
      const ratio = line.price / mid;
      if (ratio > 1.5 || ratio < 1 / 1.5) {
        add(line, "dup", "warn", "Même ligne, prix différent ailleurs dans le devis",
          `${fmt(line.price)} Ar ici, mais ${group.length - 1} autre(s) ligne(s) identique(s) sont autour de ${fmt(mid)} Ar.`);
      }
    }
  }

  // 7) Plus gros diamètre moins cher
  const diameter = /(?:ø|⌀|diam(?:etre)?\.?\s*|dn\s*)(\d{2,3})/i;
  const bySize = new Map<string, Array<{ line: CheckLine; size: number }>>();
  for (const line of priced) {
    if (line.salary) continue;
    const match = line.designation.match(diameter);
    if (!match) continue;
    const size = Number(match[1]);
    if (!(size >= 10 && size <= 400)) continue;
    const key = `${norm(line.designation.replace(match[0], "#"))}|${unitKey(line.unit)}`;
    bySize.set(key, [...(bySize.get(key) ?? []), { line, size }]);
  }
  for (const group of bySize.values()) {
    const ordered = [...group].sort((a, b) => a.size - b.size);
    for (let i = 1; i < ordered.length; i += 1) {
      const smaller = ordered[i - 1];
      const bigger = ordered[i];
      if (bigger.size > smaller.size && bigger.line.price < smaller.line.price * 0.7) {
        add(bigger.line, "size", "warn", "Un diamètre plus grand est moins cher",
          `Ø${bigger.size} à ${fmt(bigger.line.price)} Ar alors que Ø${smaller.size} (ligne ${smaller.line.position}) est à ${fmt(smaller.line.price)} Ar.`);
      }
    }
  }

  // 8) Variante « plus spécialisée » (étanche, armé, hydrofuge…) moins chère que la version simple
  const QUALIFIER = /^(etanch|hydrofug|impermea|arme|renforc|galvanis|inox)/;
  const stripQualifiers = (value: string) => norm(value).split(" ").filter((word) => !QUALIFIER.test(word)).join(" ");
  const plain = new Map<string, CheckLine>();
  for (const line of priced) {
    if (line.salary) continue;
    const words = norm(line.designation).split(" ");
    if (words.some((word) => QUALIFIER.test(word))) continue;
    const key = `${norm(line.designation)}|${unitKey(line.unit)}`;
    const current = plain.get(key);
    if (!current || line.price < current.price) plain.set(key, line);
  }
  for (const line of priced) {
    if (line.salary) continue;
    const words = norm(line.designation).split(" ");
    if (!words.some((word) => QUALIFIER.test(word))) continue;
    const base = plain.get(`${stripQualifiers(line.designation)}|${unitKey(line.unit)}`);
    if (base && line.price < base.price * 0.9) {
      add(line, "qualifier", "warn", "Version spécialisée moins chère que la version simple",
        `${fmt(line.price)} Ar ici contre ${fmt(base.price)} Ar pour « ${base.designation.slice(0, 60)} » (ligne ${base.position}).`);
    }
  }

  // 9) Comparaison avec le DAO
  if (dao && dao.length > 0) {
    const codeKey = (code: string) => norm(code).replace(/ /g, "");
    const desKey = (text: string) => norm(text).slice(0, 30);
    const estimate = lines.filter((line) => !line.internal && !line.groupHeader);
    const used = new Set<number>();
    const matched: Array<{ dao: DaoItem; line: CheckLine }> = [];
    const leftoverDao: DaoItem[] = [];
    const passes: Array<(d: DaoItem, l: CheckLine) => boolean> = [
      (d, l) => codeKey(d.code) === codeKey(l.code) && desKey(d.designation) === desKey(l.designation),
      (d, l) => Boolean(codeKey(d.code)) && codeKey(d.code) === codeKey(l.code) && unitKey(d.unit) === unitKey(l.unit),
      (d, l) => desKey(d.designation) === desKey(l.designation) && unitKey(d.unit) === unitKey(l.unit),
    ];
    let pending = [...dao];
    for (const test of passes) {
      const next: DaoItem[] = [];
      for (const item of pending) {
        const found = estimate.find((line) => !used.has(line.index) && test(item, line));
        if (found) { used.add(found.index); matched.push({ dao: item, line: found }); } else next.push(item);
      }
      pending = next;
    }
    leftoverDao.push(...pending);
    leftoverDao.forEach((item, n) => {
      add(null, "dao-missing", "error", "Poste du DAO absent du devis",
        `${item.section ? `${item.section} — ` : ""}${item.code ? `${item.code} — ` : ""}${item.designation}${item.quantity != null ? ` — ${item.quantity.toLocaleString("fr-FR")} ${item.unit}` : ""} (quantité du DAO, par ouvrage). Ajoute-le avec « + Ajouter une ligne ».`,
        undefined, `:${n}:${norm(item.designation).slice(0, 20)}`);
    });
    for (const { dao: item, line } of matched) {
      if (item.quantity == null || !(item.quantity > 0)) continue;
      const perUnit = line.quantity / (line.multiplier > 1 ? line.multiplier : 1);
      if (Math.abs(perUnit - item.quantity) > Math.max(0.005, item.quantity * 0.005)) {
        add(line, "dao-qty", "warn", "Quantité différente du DAO",
          `Devis : ${perUnit.toLocaleString("fr-FR", { maximumFractionDigits: 3 })} ${line.unit}${line.multiplier > 1 ? " (par ouvrage)" : ""}. DAO : ${item.quantity.toLocaleString("fr-FR")} ${item.unit}.`);
      }
    }
  }

  return alerts.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.index ?? 1e9) - (b.index ?? 1e9));
}
