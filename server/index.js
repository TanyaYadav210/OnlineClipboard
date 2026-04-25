const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ── Uploads folder ──────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "../uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer — 50MB max, any file type
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = uuidv4().slice(0, 8);
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${unique}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Static & middleware ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.json());

// ── In-memory rooms ─────────────────────────────────────────────────────────
const rooms = {};

function getOrCreateRoom(code) {
  if (!rooms[code]) rooms[code] = { content: "", history: [], files: [], devices: {} };
  return rooms[code];
}

// ── REST API ────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

app.get("/api/room/:code", (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.json({ content: "", history: [], files: [] });
  res.json({ content: room.content, history: room.history, files: room.files });
});

// File upload endpoint
app.post("/api/upload/:roomCode", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const room = getOrCreateRoom(req.params.roomCode);
  const fileEntry = {
    id: uuidv4().slice(0, 8),
    originalName: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedBy: req.body.deviceName || "Unknown",
    uploadedAt: new Date().toISOString(),
    url: `/uploads/${req.file.filename}`,
  };

  room.files.unshift(fileEntry);
  if (room.files.length > 20) {
    const old = room.files.pop();
    const p = path.join(UPLOADS_DIR, old.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  io.to(req.params.roomCode).emit("file-shared", fileEntry);
  res.json({ success: true, file: fileEntry });
});

// Delete file
app.delete("/api/file/:roomCode/:fileId", (req, res) => {
  const room = rooms[req.params.roomCode];
  if (!room) return res.status(404).json({ error: "Room not found" });
  const idx = room.files.findIndex((f) => f.id === req.params.fileId);
  if (idx === -1) return res.status(404).json({ error: "File not found" });
  const [file] = room.files.splice(idx, 1);
  const p = path.join(UPLOADS_DIR, file.filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  io.to(req.params.roomCode).emit("file-deleted", { id: req.params.fileId });
  res.json({ success: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Socket.IO ───────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let deviceId = uuidv4().slice(0, 8);
  let deviceName = null;

  socket.on("join-room", ({ roomCode, name }) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      const r = rooms[currentRoom];
      if (r && r.devices[deviceId]) {
        delete r.devices[deviceId];
        io.to(currentRoom).emit("devices-updated", getDeviceList(currentRoom));
      }
    }
    currentRoom = roomCode;
    deviceName = name || "Device-" + deviceId.slice(0, 4);
    const room = getOrCreateRoom(roomCode);
    room.devices[deviceId] = { name: deviceName, joinedAt: Date.now() };
    socket.join(roomCode);

    socket.emit("room-joined", {
      roomCode, deviceId,
      content: room.content,
      history: room.history,
      files: room.files,
      devices: getDeviceList(roomCode),
    });
    socket.to(roomCode).emit("device-joined", { name: deviceName });
    io.to(roomCode).emit("devices-updated", getDeviceList(roomCode));
  });

  socket.on("sync-content", ({ content }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    room.content = content;
    if (content.trim()) {
      room.history.unshift({ id: uuidv4().slice(0, 8), text: content, syncedBy: deviceName, timestamp: new Date().toISOString() });
      if (room.history.length > 20) room.history.pop();
    }
    socket.to(currentRoom).emit("content-updated", { content, syncedBy: deviceName, timestamp: new Date().toISOString() });
    socket.emit("sync-confirmed", { deviceCount: Object.keys(room.devices).length, timestamp: new Date().toISOString() });
    io.to(currentRoom).emit("history-updated", room.history);
  });

  socket.on("typing", ({ content }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("peer-typing", { deviceName, preview: content.slice(0, 60) });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.devices[deviceId];
    io.to(currentRoom).emit("device-left", { name: deviceName });
    io.to(currentRoom).emit("devices-updated", getDeviceList(currentRoom));
    if (Object.keys(room.devices).length === 0) {
      setTimeout(() => {
        if (rooms[currentRoom] && Object.keys(rooms[currentRoom].devices).length === 0) {
          (rooms[currentRoom].files || []).forEach((f) => {
            const fp = path.join(UPLOADS_DIR, f.filename);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
          });
          delete rooms[currentRoom];
        }
      }, 3600000);
    }
  });
});

function getDeviceList(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return Object.entries(room.devices).map(([id, d]) => ({ id, name: d.name, joinedAt: d.joinedAt }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`onlineclipboard running on http://localhost:${PORT}`));
