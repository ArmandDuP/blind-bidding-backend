const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

require("./games/biddingGame")(io); // Namespace: /bidding
require("./games/questionsGame")(io); // Namespace: /questions
require("./games/colorsGame")(io); // Namespace: /colors

app.get("/", (req, res) => {
  res.send("Blackout Games Server is running.");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
