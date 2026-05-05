const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://emasamir.app",
      "https://www.emasamir.app",
      "http://localhost:8888"
    ],
    methods: ["GET", "POST"]
  }
});

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_KEY
);

const DEFAULT_CHAT_ROOM = "emasamir-live";

function cleanRoom(raw){
  const r = String(raw || "").trim();
  if (!r) return DEFAULT_CHAT_ROOM;

  const clean = r.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || DEFAULT_CHAT_ROOM;
}

app.get("/", (req, res) => {
  res.send("Emas Amir Live Socket.IO OK");
});

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("join_live", (payload = {}) => {
    const room = cleanRoom(payload?.room);

    socket.join(room);

    console.log("join_live:", {
      socket_id: socket.id,
      room,
      agent_slug: payload?.agent_slug || "",
      source: payload?.source || ""
    });
  });

  socket.on("live_comment", async (payload = {}) => {
    try {
      const room = cleanRoom(payload?.room);

      const name = String(payload?.name || "Tetamu").trim();
      const phone4 = String(payload?.phone4 || "").trim();
      const message = String(payload?.message || "").trim();

      if (!message) return;

      const { data, error } = await supabase
        .from("live_chat_messages")
        .insert({
          room,
          name,
          phone4,
          message
        })
        .select()
        .single();

      if (error) throw error;

      io.to(room).emit("live_comment_new", {
        ...data,
        room,
        agent_slug: payload?.agent_slug || "",
        source: payload?.source || ""
      });

      console.log("live_comment:", {
        room,
        agent_slug: payload?.agent_slug || "",
        message
      });

    } catch (e) {
      console.error("live_comment error:", e);
      socket.emit("live_comment_error", {
        message: e.message || "Gagal hantar komen"
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("disconnect:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Socket.IO server running on port", PORT);
});
