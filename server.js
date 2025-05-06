const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = 3000;
const rooms = {};

// Generate a random room code
function generateRoomCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

// Randomly select 2–3 items for a round
function generateItemsForRound() {
  const allItems = [
    { id: "item1", name: "Sword", type: "weapon", damage: 15 },
    { id: "item2", name: "Axe", type: "weapon", damage: 20 },
    // { id: "item3", name: "Health Potion", type: "heal", amount: 20 },
    // { id: "item4", name: "Mega Heal", type: "heal", amount: 35 },
  ];

  const shuffled = allItems.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 1);
}

function startNextItemBidding(roomCode) {
  const room = rooms[roomCode];

  if (room.currentItemIndex >= room.currentItems.length) {
    // All items done → trigger attack phase
    io.to(roomCode).emit("biddingComplete");
    console.log(
      `All items bid in room ${roomCode}. Transition to attack phase.`
    );
    return;
  }

  const currentItem = room.currentItems[room.currentItemIndex];
  room.currentBids = {}; // reset bids

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
    if (amount > highestBid && amount <= player.gold) {
      highestBid = amount;
      winnerId = playerId;
    }
  }

  const result = {
    item,
    winner: null,
    bid: highestBid,
  };

  if (winnerId) {
    players[winnerId].gold -= highestBid;
    players[winnerId].items.push(item);
    if (item.type === "heal") {
      players[winnerId].health += item.amount;
    }
    result.winner = players[winnerId].name;
  }

  // Send result to room
  io.to(roomCode).emit("itemBidResult", {
    result,
    players: Object.values(players),
  });

  // Advance to next item
  room.currentItemIndex++;
  setTimeout(() => {
    startNextItemBidding(roomCode);
  }, 2000); // wait 2 sec before next item
}

function resolveAttacks(roomCode) {
  const room = rooms[roomCode];
  const results = [];

  for (const [attackerId, { targetId, weaponId }] of Object.entries(
    room.attacks
  )) {
    const attacker = room.players[attackerId];

    if (!targetId || !weaponId) {
      results.push({
        attacker: attacker.name,
        target: null,
        damage: 0,
        weapon: null,
        skipped: true,
      });
      continue;
    }

    const target = room.players[targetId];
    const weapon = attacker.items.find((i) => i.id === weaponId);

    if (!attacker || !target || !weapon) continue;

    target.health -= weapon.damage;
    results.push({
      attacker: attacker.name,
      target: target.name,
      damage: weapon.damage,
      weapon: weapon.name,
      skipped: false,
    });

    attacker.items = attacker.items.filter((i) => i.id !== weaponId);
  }

  // ✅ Remove players with 0 or less HP
  for (const [playerId, player] of Object.entries(room.players)) {
    if (player.health <= 0) {
      delete room.players[playerId];
      console.log(`${player.name} has been eliminated.`);
    }
  }

  const remainingPlayers = Object.values(room.players);

  // ✅ Check for winner
  if (remainingPlayers.length === 1) {
    const winner = remainingPlayers[0];
    io.to(roomCode).emit("gameOver", {
      winner: winner.name,
    });
    console.log(`🏆 ${winner.name} wins the game in room ${roomCode}`);
    return;
  }

  // ✅ Give bonus gold to all remaining players
  remainingPlayers.forEach((p) => (p.gold += 20));

  // ✅ Clear attacks and send results
  room.attacks = {};

  io.to(roomCode).emit("attackResults", {
    results,
    players: remainingPlayers,
  });
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // ✅ Debug log: catch all events for visibility
  socket.onAny((event, ...args) => {
    console.log(`Received event: ${event}`, args);
  });

  // ✅ Create Room
  socket.on("createRoom", (callback) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      hostId: socket.id,
      players: {},
      round: 0,
      currentItems: [],
      currentItemIndex: 0, // 👈 track progress
      currentBids: {}, // 👈 store player bids for current item
    };
    socket.join(roomCode);
    callback({ roomCode });
    console.log(`Room ${roomCode} created`);
  });

  // ✅ Host starts the round
  socket.on("startRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const items = generateItemsForRound();
    room.currentItems = items;
    room.currentItemIndex = 0;
    room.currentBids = {};

    // Start bidding on the first item
    startNextItemBidding(roomCode);
  });

  // ✅ Player joins room
  socket.on("joinRoom", ({ roomCode, playerName }, callback) => {
    const room = rooms[roomCode];
    if (!room) {
      return callback({ success: false, message: "Room not found" });
    }

    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      health: 50,
      gold: 50,
      items: [],
    };

    socket.join(roomCode);
    io.to(roomCode).emit("playersUpdate", Object.values(room.players));
    callback({ success: true });
    console.log(`${playerName} joined room ${roomCode}`);
  });

  // ✅ Player submits their bid
  socket.on("submitBid", ({ roomCode, bid }, callback) => {
    const room = rooms[roomCode];
    const player = room?.players?.[socket.id];
    if (!room || !player) return;

    const currentItem = room.currentItems[room.currentItemIndex];
    if (!currentItem) return;

    room.currentBids[socket.id] = bid;

    // All players submitted?
    if (
      Object.keys(room.currentBids).length === Object.keys(room.players).length
    ) {
      resolveCurrentItem(roomCode);
    }

    callback({ success: true });
  });

  // ✅ Handle disconnection
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

  socket.on("attack", ({ roomCode, targetId, weaponId }, callback) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.attacks) room.attacks = {};
    room.attacks[socket.id] = { targetId, weaponId }; // nulls allowed

    if (Object.keys(room.attacks).length === Object.keys(room.players).length) {
      resolveAttacks(roomCode);
    }

    callback({ success: true });
  });

  socket.on("nextRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.round += 1;
    room.currentItems = generateItemsForRound();
    room.currentItemIndex = 0;
    room.currentBids = {};
    room.attacks = {}; // clear attack choices
    room.attackResults = [];

    // Optionally: heal everyone a bit, or do something else

    io.to(roomCode).emit("playersUpdate", Object.values(room.players)); // send updated stats
    startNextItemBidding(roomCode);
    console.log(`Room ${roomCode} → Next round started`);
  });
});

// Health check route (optional)
app.get("/", (req, res) => {
  res.send("Blind Bidding Game Server is running!");
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
