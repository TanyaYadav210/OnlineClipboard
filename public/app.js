// ── State ──────────────────────────────────────────────────────────────────
let socket = null;
let currentRoom = null;
let myDeviceId = null;
let myDeviceName = null;
let typingTimer = null;
let isSyncing = false;

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const savedName = localStorage.getItem("clipsync-device-name");
  if (savedName) document.getElementById("device-name").value = savedName;

  document.getElementById("room-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
  document.getElementById("device-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("room-code").focus();
  });
});

// ── Room code generation ───────────────────────────────────────────────────
function generateRoomCode() {
  const adj = ["swift","bright","calm","bold","clear","sharp","light"];
  const noun = ["desk","note","sync","clip","link","pad","board"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  const num = Math.floor(100 + Math.random() * 900);
  document.getElementById("room-code").value = `${a}-${n}-${num}`;
}

// ── Join Room ──────────────────────────────────────────────────────────────
function joinRoom() {
  const nameInput = document.getElementById("device-name").value.trim();
  const roomInput = document.getElementById("room-code").value.trim();
  if (!nameInput) { toast("Enter your device name", "error"); return; }
  if (!roomInput) { toast("Enter or generate a room code", "error"); return; }

  myDeviceName = nameInput;
  currentRoom = roomInput.toLowerCase().replace(/\s+/g, "-");
  localStorage.setItem("onlineclipboard-device-name", myDeviceName);

  socket = io({ transports: ["websocket", "polling"] });
  setupSocketListeners();

  document.getElementById("join-screen").classList.remove("active");
  document.getElementById("app-screen").classList.add("active");
  document.getElementById("header-room").textContent = currentRoom;
}

// ── Leave Room ─────────────────────────────────────────────────────────────
function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null; }
  currentRoom = null; myDeviceId = null;
  document.getElementById("editor").value = "";
  document.getElementById("history-list").innerHTML = emptyHistoryHTML();
  document.getElementById("files-list").innerHTML = emptyFilesHTML();
  setConnection(false);
  document.getElementById("app-screen").classList.remove("active");
  document.getElementById("join-screen").classList.add("active");
}

// ── Socket.IO Setup ────────────────────────────────────────────────────────
function setupSocketListeners() {
  socket.on("connect", () => {
    setConnection(true);
    socket.emit("join-room", { roomCode: currentRoom, name: myDeviceName });
  });
  socket.on("disconnect", () => setConnection(false));
  socket.on("connect_error", () => setConnection(false));

  socket.on("room-joined", ({ deviceId, content, history, files, devices }) => {
    myDeviceId = deviceId;
    if (content) {
      document.getElementById("editor").value = content;
      updateCharCount(content);
      setEditorMeta("Loaded from room");
    }
    renderDevices(devices, deviceId);
    renderHistory(history);
    renderFiles(files || []);
    toast("Joined room · " + currentRoom, "success");
  });

  socket.on("devices-updated", (devices) => renderDevices(devices, myDeviceId));
  socket.on("device-joined", ({ name }) => toast(name + " joined the room"));
  socket.on("device-left", ({ name }) => toast(name + " left the room"));

  socket.on("content-updated", ({ content, syncedBy }) => {
    document.getElementById("editor").value = content;
    updateCharCount(content);
    setEditorMeta("Received from " + syncedBy);
    toast("Synced from " + syncedBy);
    flashDevices();
  });

  socket.on("sync-confirmed", ({ deviceCount }) => {
    isSyncing = false;
    const btn = document.getElementById("sync-btn");
    btn.classList.remove("syncing");
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Synced!`;
    toast("Synced to " + deviceCount + " device" + (deviceCount !== 1 ? "s" : ""), "success");
    setTimeout(() => {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Sync to all devices`;
    }, 2000);
    flashDevices();
  });

  socket.on("history-updated", (history) => renderHistory(history));

  socket.on("peer-typing", ({ deviceName, preview }) => {
    const bar = document.getElementById("peer-typing-bar");
    document.getElementById("peer-typing-text").textContent =
      deviceName + " is typing: " + (preview || "...");
    bar.style.display = "flex";
    clearTimeout(window._peerTypingTimer);
    window._peerTypingTimer = setTimeout(() => { bar.style.display = "none"; }, 2500);
  });

  // ── File events ──
  socket.on("file-shared", (file) => {
    prependFileItem(file, true); // true = mark as NEW
    updateFileBadge();
    toast("📎 " + file.uploadedBy + " shared: " + file.originalName, "success");
    // Auto-switch to files tab
    switchTab("files");
  });

  socket.on("file-deleted", ({ id }) => {
    const el = document.getElementById("file-" + id);
    if (el) el.remove();
    updateFileBadge();
  });
}

// ── Editor ─────────────────────────────────────────────────────────────────
function onEditorInput() {
  const val = document.getElementById("editor").value;
  updateCharCount(val);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (socket && socket.connected) socket.emit("typing", { content: val });
  }, 400);
}

function updateCharCount(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById("char-count").textContent = text.length + " chars · " + words + " words";
}

function setEditorMeta(msg) {
  document.getElementById("editor-meta").textContent =
    msg + " · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function onDrop(e) {
  e.preventDefault();
  const text = e.dataTransfer.getData("text");
  if (text) { document.getElementById("editor").value = text; onEditorInput(); return; }
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("text/")) {
    const reader = new FileReader();
    reader.onload = (ev) => { document.getElementById("editor").value = ev.target.result; onEditorInput(); };
    reader.readAsText(file);
  }
}

function syncContent() {
  if (isSyncing) return;
  const content = document.getElementById("editor").value;
  if (!content.trim()) { toast("Nothing to sync", "error"); return; }
  if (!socket || !socket.connected) { toast("Not connected", "error"); return; }
  isSyncing = true;
  const btn = document.getElementById("sync-btn");
  btn.classList.add("syncing");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Syncing...`;
  socket.emit("sync-content", { content });
}

async function copyContent() {
  const text = document.getElementById("editor").value;
  if (!text) { toast("Nothing to copy", "error"); return; }
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("copy-btn");
    btn.textContent = "Copied!"; btn.classList.add("success");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("success"); }, 2000);
    toast("Copied to clipboard", "success");
  } catch { toast("Clipboard access denied", "error"); }
}

async function pasteFromDevice() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById("editor").value = text;
    onEditorInput();
    toast("Pasted from device clipboard", "success");
  } catch { toast("Allow clipboard permission to paste", "error"); }
}

function clearEditor() {
  document.getElementById("editor").value = "";
  updateCharCount(""); setEditorMeta("Cleared");
}

function downloadContent() {
  const text = document.getElementById("editor").value;
  if (!text) { toast("Nothing to download", "error"); return; }
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "clipsync-" + currentRoom + "-" + Date.now() + ".txt";
  a.click();
  toast("Downloaded", "success");
}

function copyRoomCode() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom).catch(() => {});
  toast("Room code copied!", "success");
}

// ── FILE UPLOAD ─────────────────────────────────────────────────────────────
function onFileDragOver(e) {
  e.preventDefault();
  document.getElementById("file-drop-zone").classList.add("dragover");
}
function onFileDragLeave(e) {
  document.getElementById("file-drop-zone").classList.remove("dragover");
}
function onFileDrop(e) {
  e.preventDefault();
  document.getElementById("file-drop-zone").classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
}
function onFileSelected(e) {
  const file = e.target.files[0];
  if (file) uploadFile(file);
  e.target.value = ""; // reset so same file can be re-selected
}

function uploadFile(file) {
  if (!currentRoom) { toast("Join a room first", "error"); return; }
  if (file.size > 50 * 1024 * 1024) { toast("File too large (max 50 MB)", "error"); return; }

  const progressEl = document.getElementById("upload-progress");
  const fillEl = document.getElementById("progress-bar-fill");
  const labelEl = document.getElementById("progress-label");

  progressEl.style.display = "flex";
  fillEl.style.width = "0%";
  labelEl.textContent = "Uploading " + file.name + "...";

  const formData = new FormData();
  formData.append("file", file);
  formData.append("deviceName", myDeviceName);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload/${currentRoom}`);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      fillEl.style.width = pct + "%";
      labelEl.textContent = `Uploading ${file.name}... ${pct}%`;
    }
  };

  xhr.onload = () => {
    progressEl.style.display = "none";
    if (xhr.status === 200) {
      toast("File shared successfully!", "success");
      switchTab("files");
    } else {
      toast("Upload failed. Try again.", "error");
    }
  };

  xhr.onerror = () => {
    progressEl.style.display = "none";
    toast("Upload error. Check connection.", "error");
  };

  xhr.send(formData);
}

async function deleteFile(roomCode, fileId) {
  try {
    const res = await fetch(`/api/file/${roomCode}/${fileId}`, { method: "DELETE" });
    if (res.ok) {
      const el = document.getElementById("file-" + fileId);
      if (el) el.remove();
      updateFileBadge();
      toast("File deleted", "success");
    }
  } catch { toast("Could not delete file", "error"); }
}

// ── FILE RENDERING ──────────────────────────────────────────────────────────
function renderFiles(files) {
  const list = document.getElementById("files-list");
  if (!files || !files.length) { list.innerHTML = emptyFilesHTML(); updateFileBadge(); return; }
  list.innerHTML = "";
  files.forEach((f) => prependFileItem(f, false));
  updateFileBadge();
}

function prependFileItem(file, isNew) {
  const list = document.getElementById("files-list");
  const emptyEl = list.querySelector(".history-empty");
  if (emptyEl) emptyEl.remove();

  const ext = file.originalName.split(".").pop().toLowerCase();
  const isImage = ["jpg","jpeg","png","gif","webp","svg"].includes(ext);
  const isPdf = ext === "pdf";
  const isDoc = ["doc","docx","txt","md","csv"].includes(ext);
  const isZip = ["zip","rar","7z","tar","gz"].includes(ext);

  let iconClass = "other";
  let iconText = ext.slice(0, 4);
  if (isPdf) { iconClass = "pdf"; iconText = "PDF"; }
  else if (isImage) { iconClass = "img"; iconText = "IMG"; }
  else if (isDoc) { iconClass = "doc"; iconText = "DOC"; }
  else if (isZip) { iconClass = "zip"; iconText = "ZIP"; }

  const div = document.createElement("div");
  div.className = "file-item";
  div.id = "file-" + file.id;
  div.innerHTML = `
    <div class="file-item-top">
      <div class="file-icon ${iconClass}">${iconText}</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(file.originalName)}">
          ${escHtml(file.originalName)}
          ${isNew ? '<span class="file-new-badge">New</span>' : ""}
        </div>
        <div class="file-meta">${formatSize(file.size)} · ${escHtml(file.uploadedBy)} · ${formatTime(file.uploadedAt)}</div>
      </div>
    </div>
    ${isImage ? `<img src="${file.url}" class="file-preview" alt="${escHtml(file.originalName)}" />` : ""}
    <div class="file-item-actions" style="margin-top:8px;">
      <a href="${file.url}" target="_blank" class="file-btn primary" download="${escHtml(file.originalName)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </a>
      ${isImage || isPdf ? `<a href="${file.url}" target="_blank" class="file-btn">Preview</a>` : ""}
      <button class="file-btn danger" onclick="deleteFile('${currentRoom}', '${file.id}')">Delete</button>
    </div>
  `;
  list.prepend(div);

  // Remove "New" badge after 5s
  if (isNew) {
    setTimeout(() => {
      const badge = div.querySelector(".file-new-badge");
      if (badge) badge.remove();
    }, 5000);
  }
}

function updateFileBadge() {
  const count = document.querySelectorAll(".file-item").length;
  const badge = document.getElementById("file-badge");
  if (count > 0) { badge.textContent = count; badge.style.display = "inline"; }
  else { badge.style.display = "none"; }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function emptyFilesHTML() {
  return `<div class="history-empty">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
    <p>No files shared yet.<br/>Drop a file to share it.</p>
  </div>`;
}

// ── TABS ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("pane-history").classList.toggle("active", tab === "history");
  document.getElementById("pane-files").classList.toggle("active", tab === "files");
  document.getElementById("tab-history").classList.toggle("active", tab === "history");
  document.getElementById("tab-files").classList.toggle("active", tab === "files");
}

// ── DEVICES ────────────────────────────────────────────────────────────────
function renderDevices(devices, myId) {
  const bar = document.getElementById("devices-bar");
  if (!devices || !devices.length) { bar.innerHTML = ""; return; }
  bar.innerHTML = devices.map((d) => `
    <div class="device-chip ${d.id === myId ? "me" : ""}">
      <div class="device-chip-dot"></div>
      ${escHtml(d.name)}${d.id === myId ? " (you)" : ""}
    </div>
  `).join("");
}

function flashDevices() {
  document.querySelectorAll(".device-chip:not(.me)").forEach((chip, i) => {
    setTimeout(() => {
      chip.classList.add("synced");
      setTimeout(() => chip.classList.remove("synced"), 1000);
    }, i * 200);
  });
}

// ── HISTORY ────────────────────────────────────────────────────────────────
function renderHistory(history) {
  const list = document.getElementById("history-list");
  if (!history || !history.length) { list.innerHTML = emptyHistoryHTML(); return; }
  list.innerHTML = history.map((h) => `
    <div class="history-item" onclick="loadHistory('${escAttr(h.text)}')">
      <div class="history-item-text">${escHtml(h.text)}</div>
      <div class="history-item-meta">
        <span>${escHtml(h.syncedBy)} · ${formatTime(h.timestamp)}</span>
        <button class="history-use-btn">Use</button>
      </div>
    </div>
  `).join("");
}

function loadHistory(text) {
  document.getElementById("editor").value = text;
  onEditorInput();
  toast("Loaded into editor");
}

function clearHistory() {
  document.getElementById("history-list").innerHTML = emptyHistoryHTML();
  toast("History cleared");
}

function emptyHistoryHTML() {
  return `<div class="history-empty">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>
    <p>No syncs yet.<br/>Start typing and hit sync.</p>
  </div>`;
}

// ── CONNECTION ─────────────────────────────────────────────────────────────
function setConnection(connected) {
  document.getElementById("conn-dot").className = "conn-dot " + (connected ? "connected" : "disconnected");
  document.getElementById("conn-label").textContent = connected ? "Connected" : "Disconnected";
}

// ── TOAST ──────────────────────────────────────────────────────────────────
function toast(msg, type = "") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 0.3s"; setTimeout(() => el.remove(), 300); }, 2500);
}

// ── UTILS ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function escAttr(s) {
  if (!s) return "";
  return String(s).replace(/'/g,"\\'").replace(/\n/g,"\\n");
}
function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString();
}
