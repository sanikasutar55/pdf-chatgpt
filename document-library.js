const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const pdfParse = require("pdf-parse");

function createDocumentLibrary({ ollamaUrl, embeddingModel }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  });
  const directory = path.join(__dirname, "data", "documents");
  const indexPath = path.join(directory, "index.json");
  const documents = new Map();

  async function initialize() {
    await fs.mkdir(directory, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(indexPath, "utf8"));
      for (const document of saved) {
        if (await fs.access(path.join(directory, `${document.id}.pdf`)).then(() => true, () => false)) {
          documents.set(document.id, document);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function persist() {
    const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify([...documents.values()]));
    await fs.rename(temporaryPath, indexPath);
  }

  async function embed(texts) {
    const response = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embeddingModel, input: texts }),
    });
    if (!response.ok) throw new Error(`Embedding request failed (${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error("Ollama returned an invalid embedding response.");
    }
    return data.embeddings;
  }

  function makeChunks(pageTexts) {
    const chunks = [];
    for (const [index, pageText] of pageTexts.entries()) {
      const words = pageText.trim().split(/\s+/).filter(Boolean);
      for (let start = 0; start < words.length;) {
        const end = Math.min(start + 180, words.length);
        const text = words.slice(start, end).join(" ");
        if (text) chunks.push({ text, page_number: index + 1 });
        if (end === words.length) break;
        start = end - 30;
      }
    }
    return chunks;
  }

  function publicDocument(document) {
    return {
      id: document.id,
      filename: document.filename,
      status: document.status,
      page_count: document.page_count,
      chunk_count: document.chunk_count,
    };
  }

  router.get("/", (req, res) => {
    const items = [...documents.values()].map(publicDocument);
    res.json({ documents: items });
  });

  router.post("/", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ detail: "Choose a PDF to upload." });
    if (req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
      return res.status(400).json({ detail: "The selected file is not a valid PDF." });
    }

    const id = randomUUID();
    const filePath = path.join(directory, `${id}.pdf`);
    try {
      const pageTexts = [];
      const parsed = await pdfParse(req.file.buffer, {
        pagerender: async (page) => {
          const content = await page.getTextContent();
          const text = content.items.map((item) => item.str || "").join(" ");
          pageTexts[(page.pageNumber || page.pageIndex + 1) - 1] = text;
          return text;
        },
      });
      const chunks = makeChunks(pageTexts);
      if (!chunks.length) {
        return res.status(422).json({ detail: "No readable text was found in this PDF. Scanned PDFs need OCR." });
      }

      for (let offset = 0; offset < chunks.length; offset += 32) {
        const batch = chunks.slice(offset, offset + 32);
        const embeddings = await embed(batch.map((chunk) => chunk.text));
        batch.forEach((chunk, index) => { chunk.embedding = embeddings[index]; });
      }

      const document = {
        id,
        filename: path.basename(req.file.originalname),
        status: "indexed",
        page_count: parsed.numpages,
        chunk_count: chunks.length,
        chunks,
      };
      await fs.writeFile(filePath, req.file.buffer);
      documents.set(id, document);
      await persist();
      res.status(201).json({ document: publicDocument(document) });
    } catch (error) {
      await fs.rm(filePath, { force: true });
      res.status(500).json({ detail: error.message || "Could not index this PDF." });
    }
  });

  router.delete("/:id", async (req, res) => {
    const document = documents.get(req.params.id);
    if (!document) return res.sendStatus(204);
    documents.delete(document.id);
    await fs.rm(path.join(directory, `${document.id}.pdf`), { force: true });
    await persist();
    res.sendStatus(204);
  });

  function cosineSimilarity(left, right) {
    let dot = 0;
    let leftLength = 0;
    let rightLength = 0;
    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index];
      leftLength += left[index] ** 2;
      rightLength += right[index] ** 2;
    }
    return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength) || 1);
  }

  async function findRelevantChunks(question, documentIds) {
    const allowed = documentIds?.length
      ? [...documents.values()].filter((document) => documentIds.includes(document.id))
      : [...documents.values()];
    const chunks = allowed.flatMap((document) => document.chunks.map((chunk) => ({
      ...chunk,
      document_id: document.id,
      document_name: document.filename,
    })));
    if (!chunks.length) return [];

    const [questionEmbedding] = await embed([question]);
    return chunks
      .map((chunk) => ({ ...chunk, relevance_score: cosineSimilarity(questionEmbedding, chunk.embedding) }))
      .sort((left, right) => right.relevance_score - left.relevance_score)
      .slice(0, 5);
  }

  return { router, initialize, findRelevantChunks };
}

module.exports = { createDocumentLibrary };