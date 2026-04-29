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

const CHAT_ROOM = "emasamir-live";

app.get("/", (req, res) => {
  res.send("Emas Amir Live Socket.IO OK");
});

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("join_live", () => {
    socket.join(CHAT_ROOM);
  });

  socket.on("live_comment", async (payload) => {
    try {
      const name = String(payload?.name || "Tetamu").trim();
      const phone4 = String(payload?.phone4 || "").trim();
      const message = String(payload?.message || "").trim();

      if (!message) return;

      const { data, error } = await supabase
        .from("live_chat_messages")
        .insert({
          room: CHAT_ROOM,
          name,
          phone4,
          message
        })
        .select()
        .single();

      if (error) throw error;

      io.to(CHAT_ROOM).emit("live_comment_new", data);
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