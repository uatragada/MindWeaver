import { readFile } from "node:fs/promises";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import JSZip from "jszip";

function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

async function extractTextFromPptx(filePath, { readFileImpl = readFile, zipImpl = JSZip } = {}) {
  const zip = await zipImpl.loadAsync(await readFileImpl(filePath));
  const slideFiles = Object.keys(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const chunks = [];

  for (const slideFile of slideFiles) {
    const xml = await zip.files[slideFile].async("string");
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)]
      .map((match) => decodeXmlText(match[1]))
      .join(" ")
      .trim();
    if (text) chunks.push(text);
  }

  return chunks.join("\n\n");
}

async function extractImportFile(filePath, {
  readFileImpl = readFile,
  pdfParseImpl = pdfParse,
  mammothImpl = mammoth,
  zipImpl = JSZip
} = {}) {
  const fileName = filePath.split(/[\\/]/).pop() || "Imported document";
  const extension = (fileName.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

  if (["txt", "text", "md", "markdown"].includes(extension)) {
    return {
      title: fileName,
      content: await readFileImpl(filePath, "utf8"),
      sourceType: ["md", "markdown"].includes(extension) ? "markdown" : "note"
    };
  }

  if (extension === "pdf") {
    const parsed = await pdfParseImpl(await readFileImpl(filePath));
    return {
      title: fileName,
      content: parsed.text,
      sourceType: "pdf"
    };
  }

  if (extension === "docx") {
    const parsed = await mammothImpl.extractRawText({ path: filePath });
    return {
      title: fileName,
      content: parsed.value,
      sourceType: "doc"
    };
  }

  if (extension === "pptx") {
    return {
      title: fileName,
      content: await extractTextFromPptx(filePath, { readFileImpl, zipImpl }),
      sourceType: "doc"
    };
  }

  throw new Error(`${fileName} is not a supported tray import format yet.`);
}

export {
  decodeXmlText,
  extractImportFile,
  extractTextFromPptx
};
