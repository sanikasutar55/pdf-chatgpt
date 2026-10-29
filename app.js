(() => {
  "use strict";

  const API_BASE = "";
  const state = {
    conversationId: null,
    documents: [],
    conversations: [],
    isStreaming: false,
  };

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const el = {
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    themeToggle: document.getElementById("theme-toggle"),
    newChatBtn: document.getElementById("new-chat-btn"),
    fileInput: document.getElementById("file-input"),
    uploadProgress: document.getElementById("upload-progress"),
    uploadProgressText: document.getElementById("upload-progress-text"),
    documentList: document.getElementById("document-list"),
    conversationList: document.getElementById("conversation-list"),
    documentScope: document.getElementById("document-scope"),
    chatMessages: document.getElementById("chat-messages"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    sendBtn: document.getElementById("send-btn"),
    conversationTitle: document.getElementById("conversation-title"),
    healthIndicator: document.getElementById("health-indicator"),
  };

  marked.setOptions({
    breaks: true,
    highlight: (code, lang) => {
      try {
        return lang && hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang }).value
          : hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
  });

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem("pdf-chatgpt-theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
  }

  el.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("pdf-chatgpt-theme", next);
  });

  el.sidebarToggle.addEventListener("click", () => {
    el.sidebar.classList.toggle("open");
  });

  // ---------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------
  function toast(message, kind = "info") {
    let container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    container.appendChild(node);
    setTimeout(() => node.remove(), 5000);
  }

  // ---------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------
  async function checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (!res.ok) throw new Error("API unavailable");
      const data = await res.json();
      const configured = data.ollama_configured;
      el.healthIndicator.classList.remove("ok", "down");
      el.healthIndicator.classList.add(configured ? "ok" : "down");
      el.healthIndicator.title = configured
        ? `Ollama ready — ${data.model} available`
        : `Ollama is unavailable or ${data.model} is not installed`;
    } catch {
      el.healthIndicator.classList.add("down");
      el.healthIndicator.title = "API unreachable";
    }
  }

  // ---------------------------------------------------------------------
  // Document library
  // ---------------------------------------------------------------------
  async function refreshDocuments() {
    try {
      const res = await fetch(`${API_BASE}/api/documents`);
      if (!res.ok) throw new Error("Failed to load documents");
      const data = await res.json();
      state.documents = data.documents;
      renderDocumentList();
      renderDocumentScope();
    } catch (err) {
      console.error(err);
    }
  }

  function renderDocumentList() {
    el.documentList.innerHTML = "";
    if (state.documents.length === 0) {
      el.documentList.innerHTML = '<li class="empty-state">No documents yet. Upload a PDF to get started.</li>';
      return;
    }
    for (const doc of state.documents) {
      const li = document.createElement("li");
      li.className = "document-item";
      li.innerHTML = `
        <div class="document-item-row">
          <span class="document-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</span>
          <button class="delete-doc-btn" data-id="${doc.id}" title="Delete document">
            <svg class="icon" viewBox="0 0 24 24" width="14" height="14"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
          </button>
        </div>
        <div class="document-meta">
          <span class="status-badge status-${doc.status}">${doc.status}</span>
          &middot; ${doc.page_count} pages &middot; ${doc.chunk_count} chunks
        </div>`;
      el.documentList.appendChild(li);
    }
    el.documentList.querySelectorAll(".delete-doc-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteDocument(btn.dataset.id));
    });
  }

  function renderDocumentScope() {
    const previous = el.documentScope.value;
    el.documentScope.innerHTML = '<option value="">All documents</option>';
    for (const doc of state.documents) {
      if (doc.status !== "indexed") continue;
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.filename;
      el.documentScope.appendChild(opt);
    }
    el.documentScope.value = previous || "";
  }

  async function deleteDocument(id) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    try {
      const res = await fetch(`${API_BASE}/api/documents/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("Delete failed");
      toast("Document deleted.", "success");
      await refreshDocuments();
    } catch (err) {
      toast("Failed to delete document.", "error");
    }
  }

  async function uploadFiles(files) {
    for (const file of files) {
      if (file.type !== "application/pdf") {
        toast(`${file.name} is not a PDF file.`, "error");
        continue;
      }
      el.uploadProgress.classList.remove("hidden");
      el.uploadProgressText.textContent = `Indexing ${file.name}...`;
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch(`${API_BASE}/api/documents`, { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Upload failed");
        toast(`${file.name} indexed successfully.`, "success");
      } catch (err) {
        toast(`Failed to index ${file.name}: ${err.message}`, "error");
      }
    }
    el.uploadProgress.classList.add("hidden");
    await refreshDocuments();
  }

  el.fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) uploadFiles(Array.from(e.target.files));
    e.target.value = "";
  });

  // ---------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------
  async function refreshConversations() {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`);
      if (!res.ok) throw new Error("Failed to load conversations");
      const data = await res.json();
      state.conversations = data.conversations;
      renderConversationList();
    } catch (err) {
      console.error(err);
    }
  }

  function renderConversationList() {
    el.conversationList.innerHTML = "";
    if (state.conversations.length === 0) {
      el.conversationList.innerHTML = '<li class="empty-state">No conversations yet.</li>';
      return;
    }
    for (const conv of state.conversations) {
      const li = document.createElement("li");
      li.className = "conversation-item" + (conv.id === state.conversationId ? " active" : "");
      li.textContent = conv.title || "Untitled conversation";
      li.addEventListener("click", () => loadConversation(conv.id));
      el.conversationList.appendChild(li);
    }
  }

  async function loadConversation(id) {
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`);
      if (!res.ok) throw new Error("Conversation not found");
      const data = await res.json();
      state.conversationId = data.id;
      el.conversationTitle.textContent = data.title || "Conversation";
      el.chatMessages.innerHTML = "";
      for (const msg of data.messages) {
        appendMessage(msg.role, msg.content, msg.sources || []);
      }
      renderConversationList();
    } catch (err) {
      toast("Failed to load conversation.", "error");
    }
  }

  el.newChatBtn.addEventListener("click", () => {
    state.conversationId = null;
    el.conversationTitle.textContent = "New Conversation";
    el.chatMessages.innerHTML = `
      <div class="welcome-card">
        <h2>Welcome to PDF-ChatGPT</h2>
        <p>Upload one or more PDF documents, then ask questions in natural language. Answers are generated
           using Retrieval-Augmented Generation (RAG) and always cite the source document and page.</p>
      </div>`;
    renderConversationList();
  });

  // ---------------------------------------------------------------------
  // Chat / streaming
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function appendMessage(role, content, sources = []) {
    const welcome = el.chatMessages.querySelector(".welcome-card");
    if (welcome) welcome.remove();

    const row = document.createElement("div");
    row.className = `message-row ${role}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "You" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = marked.parse(content || "");

    if (sources.length) {
      const block = document.createElement("div");
      block.className = "sources-block";
      block.innerHTML = sources
        .map(
          (s) =>
            `<div class="source-chip"><b>${escapeHtml(s.document_name)}</b> — page ${s.page_number} (relevance ${(s.relevance_score * 100).toFixed(0)}%)</div>`
        )
        .join("");
      bubble.appendChild(block);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    el.chatMessages.appendChild(row);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    return bubble;
  }

  function appendTypingIndicator() {
    const row = document.createElement("div");
    row.className = "message-row assistant";
    row.id = "typing-row";
    row.innerHTML = `
      <div class="avatar">AI</div>
      <div class="bubble"><span class="typing-indicator"><span></span><span></span><span></span></span></div>`;
    el.chatMessages.appendChild(row);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function removeTypingIndicator() {
    document.getElementById("typing-row")?.remove();
  }

  async function sendMessage(question) {
    if (state.isStreaming) return;
    state.isStreaming = true;
    el.sendBtn.disabled = true;

    appendMessage("user", question);
    appendTypingIndicator();

    const payload = {
      question,
      conversation_id: state.conversationId,
      document_ids: el.documentScope.value ? [el.documentScope.value] : null,
    };

    try {
      const res = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Request failed (${res.status})`);
      }

      removeTypingIndicator();
      const bubble = appendMessage("assistant", "");
      let buffer = "";
      let answerText = "";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const { event, data } = parseSSE(rawEvent);
          if (!event) continue;
          if (event === "meta") {
            state.conversationId = data.conversation_id;
          } else if (event === "token") {
            answerText += data.text;
            bubble.innerHTML = marked.parse(answerText);
            el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
          } else if (event === "sources" && data.sources?.length) {
            const block = document.createElement("div");
            block.className = "sources-block";
            block.innerHTML = data.sources
              .map(
                (s) =>
                  `<div class="source-chip"><b>${escapeHtml(s.document_name)}</b> — page ${s.page_number} (relevance ${(s.relevance_score * 100).toFixed(0)}%)</div>`
              )
              .join("");
            bubble.appendChild(block);
          } else if (event === "error") {
            throw new Error(data.detail || "Streaming error");
          }
        }
      }

      hljs.highlightAll();
      await refreshConversations();
      el.conversationTitle.textContent =
        state.conversations.find((c) => c.id === state.conversationId)?.title || "Conversation";
    } catch (err) {
      removeTypingIndicator();
      appendMessage("assistant", `⚠️ **Error:** ${err.message}`);
      toast(err.message, "error");
    } finally {
      state.isStreaming = false;
      el.sendBtn.disabled = false;
    }
  }

  function parseSSE(rawEvent) {
    const lines = rawEvent.split("\n");
    let event = null;
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    let data = {};
    try {
      data = dataStr ? JSON.parse(dataStr) : {};
    } catch {
      data = {};
    }
    return { event, data };
  }

  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = el.chatInput.value.trim();
    if (!question) return;
    el.chatInput.value = "";
    el.chatInput.style.height = "auto";
    sendMessage(question);
  });

  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.chatForm.requestSubmit();
    }
  });

  el.chatInput.addEventListener("input", () => {
    el.chatInput.style.height = "auto";
    el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 160)}px`;
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  initTheme();
  checkHealth();
  refreshDocuments();
  refreshConversations();
})();