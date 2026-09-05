import { describe, expect, it } from "vitest";
import { extractPdfText, extractPlainText, kindFromFilename, rtfToPlainText } from "./text-extract.js";

describe("text-extract", () => {
  it("passes through markdown", () => {
    const md = "# Hello\n\nWorld";
    const { text, kind } = extractPlainText(Buffer.from(md), "note.md");
    expect(kind).toBe("md");
    expect(text).toBe(md);
  });

  it("strips simple RTF", () => {
    const rtf = "{\\rtf1\\ansi Hello\\par world}";
    expect(rtfToPlainText(rtf)).toMatch(/Hello/);
    expect(rtfToPlainText(rtf)).toMatch(/world/);
    expect(rtfToPlainText(rtf)).not.toMatch(/rtf1/);
  });

  it("rejects unknown extensions", () => {
    expect(() => extractPlainText(Buffer.from("x"), "photo.png")).toThrow(/Unsupported/);
  });

  it("classifies PDFs and keeps them off the knowledge-export path", () => {
    expect(kindFromFilename("brief.pdf")).toBe("pdf");
    expect(() => extractPlainText(Buffer.from("%PDF"), "brief.pdf")).toThrow(/Document ingest/);
  });

  it("rejects invalid PDF bytes", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toThrow(/Could not read this PDF/);
  });

  it("extracts text from a minimal PDF", async () => {
    const { text, pages, pageCount } = await extractPdfText(minimalPdf("Hello Alfred"));
    expect(pageCount).toBe(1);
    expect(pages.some((p) => /Hello Alfred/.test(p))).toBe(true);
    expect(text).toMatch(/# Page 1/);
    expect(text).toMatch(/Hello Alfred/);
  });
});

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
