const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { createDocumentLibrary } = require("./document-library");

const app = express();
const port = Number(process.env.PORT || 4173);
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const model = process.env.OLLAMA_MODEL || "llama3.2";
const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
const conversations = new Map();
const library = createDocumentLibrary({ ollamaUrl, embeddingModel });

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/static/css/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/static/js/app.js", (req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/static/favicon.svg", (req, res) => res.sendFile(path.join(__dirname, "favicon.svg")));

app.get("/api/health", async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) throw new Error("Ollama is unavailable");
    const data = await response.json();
    const configured = data.models?.some((entry) => entry.name.startsWith(model));
    res.json({ ollama_configured: Boolean(configured), model });
  } catch {
    res.status(503).json({ ollama_configured: false, model });
  }
});

app.use("/api/documents", library.router);

app.get("/api/conversations", (req, res) => {
  const items = [...conversations.values()]
    .map(({ id, title, updated_at }) => ({ id, title, updated_at }))
    .sort((left, right) => right.updated_at - left.updated_at);
  res.json({ conversations: items });
});

app.get("/api/conversations/:id", (req, res) => {
  const conversation = conversations.get(req.params.id);
  if (!conversation) return res.status(404).json({ detail: "Conversation not found." });
  res.json(conversation);
});

app.post("/api/chat/stream", async (req, res) => {
  const question = req.body?.question?.trim();
  if (!question) return res.status(400).json({ detail: "A question is required." });

  let sources;
  try {
    sources = await library.findRelevantChunks(question, req.body.document_ids);
  } catch {
    return res.status(503).json({ detail: "Could not search documents. Check that Ollama and the embedding model are running." });
  }

  let conversation = conversations.get(req.body.conversation_id);
  if (!conversation) {
    conversation = {
      id: randomUUID(),
      title: question.slice(0, 60),
      messages: [],
      updated_at: Date.now(),
    };
    conversations.set(conversation.id, conversation);
  }

  conversation.messages.push({ role: "user", content: question });
  conversation.updated_at = Date.now();

  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: sources.length
          ? [{
              role: "system",
              content: `Answer using the document excerpts below. If they do not answer the question, say so. Cite supporting claims as [document name, page N].\n\n${sources.map((source) => `[${source.document_name}, page ${source.page_number}] ${source.text}`).join("\n\n")}`,
            }, ...conversation.messages]
          : conversation.messages,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama returned ${response.status}`);
  } catch {
    conversation.messages.pop();
    return res.status(503).json({ detail: "Ollama is unavailable. Start Ollama and try again." });
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: meta\ndata: ${JSON.stringify({ conversation_id: conversation.id })}\n\n`);
  if (sources.length) {
    res.write(`event: sources\ndata: ${JSON.stringify({
      sources: sources.map(({ document_name, page_number, relevance_score }) => ({
        document_name,
        page_number,
        relevance_score,
      })),
    })}\n\n`);
  }

  let answer = "";
  let pending = "";
  const sendToken = (token) => {
    answer += token;
    res.write(`event: token\ndata: ${JSON.stringify({ text: token })}\n\n`);
  };

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.message?.content) sendToken(chunk.message.content);
      }
      if (done) break;
    }
    if (pending.trim()) {
      const chunk = JSON.parse(pending);
      if (chunk.message?.content) sendToken(chunk.message.content);
    }
    conversation.messages.push({ role: "assistant", content: answer });
    conversation.updated_at = Date.now();
    res.end();
  } catch {
    res.write(`event: error\ndata: ${JSON.stringify({ detail: "The Ollama response could not be read." })}\n\n`);
    res.end();
  }
});

app.get("/api/docs", (req, res) => {
  res.json({ service: "PDF-ChatGPT local API", model, embedding_model: embeddingModel, pdf_indexing: true });
});

library.initialize().then(() => {
  app.listen(port, "127.0.0.1", () => {
    console.log(`PDF-ChatGPT server listening at http://127.0.0.1:${port}`);
  });
}).catch((error) => {
  console.error("Could not initialize document library:", error);
  process.exitCode = 1;
});