const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3000;
const rooms = {};

function generateRoomCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

function generateItemsForRound() {
  const allItems = [
    //Drinks
    { id: "shot", name: "Shot", type: "drink", effect: -1 },
    { id: "beer", name: "Beer", type: "drink", effect: -2 },
    { id: "wine", name: "Wine", type: "drink", effect: -3 },
    { id: "cocktail", name: "Cocktail", type: "drink", effect: -5 },
    //Water
    { id: "glassWater", name: "Glass of Water", type: "water", effect: +2 },
    { id: "bottleWater", name: "Bottle of Water", type: "water", effect: +4 },
    { id: "rehydrate", name: "Re-Hydrate", type: "water", effect: +6 },
  ];

  const shuffled = allItems.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3);
}

function startNextItemBidding(roomCode) {
  const room = rooms[roomCode];

  if (room.currentItemIndex >= room.currentItems.length) {
    io.to(roomCode).emit("biddingComplete");
    console.log(
      `All items bid in room ${roomCode}. Transition to drink phase.`
    );
    return;
  }

  const currentItem = room.currentItems[room.currentItemIndex];
  room.currentBids = {};

  io.to(roomCode).emit("newItemToBid", { item: currentItem });
  console.log(`Room ${roomCode}: Bidding started for item ${currentItem.name}`);
}

function resolveCurrentItem(roomCode) {
  const room = rooms[roomCode];
  const item = room.currentItems[room.currentItemIndex];
  const bids = room.currentBids;
  const players = room.players;

  let highestBid = -1;
  let winnerId = null;

  for (const [playerId, amount] of Object.entries(bids)) {
    const player = players[playerId];
    if (amount > highestBid && amount <= player.blackoutBucks) {
      highestBid = amount;
      winnerId = playerId;
    }
  }

  const result = { item, winner: null, bid: highestBid };

  if (winnerId) {
    players[winnerId].blackoutBucks -= highestBid;

    if (item.type === "water") {
      players[winnerId].vision += item.effect;
      // Don't store the water item, it's consumed immediately
    } else {
      players[winnerId].items.push(item); // Keep drink items
    }

    result.winner = players[winnerId].name;
  }

  io.to(roomCode).emit("itemBidResult", {
    result,
    players: Object.values(players),
  });

  room.currentItemIndex++;
  setTimeout(() => startNextItemBidding(roomCode), 2000);
}

function resolveDrinks(roomCode) {
  const room = rooms[roomCode];
  const results = [];

  for (const [giverId, { targetId, drinkId }] of Object.entries(room.attacks)) {
    const giver = room.players[giverId];

    if (!giver) continue;

    if (!targetId || !drinkId) {
      results.push({
        attacker: giver.name,
        target: null,
        damage: 0,
        weapon: null,
        skipped: true,
      });
      continue;
    }

    const target = room.players[targetId];
    const drink = giver.items.find((i) => i.id === drinkId);

    if (!target || !drink) continue;

    target.vision += drink.effect;
    results.push({
      attacker: giver.name,
      target: target.name,
      damage: drink.effect,
      weapon: drink.name,
      skipped: false,
    });

    giver.items = giver.items.filter((i) => i.id !== drinkId);
  }

  for (const [id, player] of Object.entries(room.players)) {
    if (player.vision <= 0) {
      delete room.players[id];
      console.log(`${player.name} has blacked out!`);
    }
  }

  const survivors = Object.values(room.players);

  if (survivors.length === 1) {
    io.to(roomCode).emit("gameOver", { winner: survivors[0].name });
    console.log(`🏆 ${survivors[0].name} wins the game in room ${roomCode}`);
    return;
  }

  survivors.forEach((p) => (p.blackoutBucks += 20));

  room.attacks = {};
  io.to(roomCode).emit("attackResults", {
    results,
    players: survivors,
  });
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.onAny((event, ...args) => {
    console.log(`Received event: ${event}`, args);
  });

  socket.on("createRoom", (callback) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      hostId: socket.id,
      players: {},
      round: 0,
      currentItems: [],
      currentItemIndex: 0,
      currentBids: {},
    };
    socket.join(roomCode);
    callback({ roomCode });
    console.log(`Room ${roomCode} created`);
  });

  socket.on("startRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.vipId !== socket.id) return;

    const items = generateItemsForRound();
    room.currentItems = items;
    room.currentItemIndex = 0;
    room.currentBids = {};

    startNextItemBidding(roomCode);
  });

  socket.on("joinRoom", ({ roomCode, playerName }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, message: "Room not found" });

    const isFirstPlayer = Object.keys(room.players).length === 0;

    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      vision: 20,
      blackoutBucks: 50,
      items: [],
      isVIP: isFirstPlayer,
    };

    if (isFirstPlayer) {
      room.vipId = socket.id;
    }

    socket.join(roomCode);
    io.to(roomCode).emit("playersUpdate", Object.values(room.players));
    callback({ success: true, isVIP: isFirstPlayer });
    console.log(`${playerName} joined room ${roomCode}`);
  });

  socket.on("submitBid", ({ roomCode, bid }, callback) => {
    const room = rooms[roomCode];
    const player = room?.players?.[socket.id];
    if (!room || !player) return;

    const currentItem = room.currentItems[room.currentItemIndex];
    if (!currentItem) return;

    room.currentBids[socket.id] = bid;

    if (
      Object.keys(room.currentBids).length === Object.keys(room.players).length
    ) {
      resolveCurrentItem(roomCode);
    }

    callback({ success: true });
  });

  socket.on("attack", ({ roomCode, targetId, weaponId }, callback) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.attacks) room.attacks = {};
    room.attacks[socket.id] = { targetId, drinkId: weaponId };

    if (Object.keys(room.attacks).length === Object.keys(room.players).length) {
      resolveDrinks(roomCode);
    }

    callback({ success: true });
  });

  socket.on("nextRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.vipId !== socket.id) return;

    room.round += 1;
    room.currentItems = generateItemsForRound();
    room.currentItemIndex = 0;
    room.currentBids = {};
    room.attacks = {};
    room.attackResults = [];

    io.to(roomCode).emit("playersUpdate", Object.values(room.players));
    startNextItemBidding(roomCode);
    console.log(`Room ${roomCode} → Next round started`);
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        const playerName = room.players[socket.id].name;
        delete room.players[socket.id];
        io.to(code).emit("playersUpdate", Object.values(room.players));
        console.log(`${playerName} disconnected from room ${code}`);
      }
    }
  });
});

app.get("/", (req, res) => {
  res.send("Party Drinking Game Server is running!");
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
