import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter(l => l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0,i), l.slice(i+1)]; }));
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: t } = await supabase.from("tenders").select("document_url").eq("id", "2ddd2a15-70f3-4427-9361-e5fd58da2214").maybeSingle();
const source = await fetch(t!.document_url!);
const bytes = new Uint8Array(await source.arrayBuffer());
const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;

const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject]);
const pathOps = new Set([OPS.constructPath, OPS.fill, OPS.stroke, OPS.eoFill]);

for (const p of [120, 121, 122, 123, 124, 125, 188, 189, 190, 225, 226, 227]) {
  const page = await doc.getPage(p);
  const opList = await page.getOperatorList();
  let images = 0, paths = 0, textShow = 0;
  for (const fn of opList.fnArray) {
    if (imageOps.has(fn)) images++;
    else if (pathOps.has(fn)) paths++;
    else if (fn === OPS.showText) textShow++;
  }
  console.log(`Page ${p}: total=${opList.fnArray.length} images=${images} paths=${paths} textShow=${textShow}`);
}
