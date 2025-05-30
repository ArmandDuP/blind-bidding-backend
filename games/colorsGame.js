const crypto = require("crypto");

module.exports = function (io) {
  const colorsNamespace = io.of("/colors");

  const rooms = {};

  function generateRoomCode() {
    return crypto.randomBytes(2).toString("hex").toUpperCase();
  }

  function getRandomFromArray(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  const COLORS = ["red", "blue", "yellow", "green"];
  const PROMPTS = ["buttonColor", "textContent", "textColor"];

  function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
  }

  // Generates round data for one question
  function generateRound() {
    const targetColor = getRandomFromArray(COLORS);
    const prompt = getRandomFromArray(PROMPTS);

    const shuffledButtonColors = shuffle([...COLORS]);
    const shuffledTextColors = shuffle([...COLORS]);
    const shuffledTextContents = shuffle([...COLORS]);

    const options = [];

    for (let i = 0; i < 4; i++) {
      let buttonColor = shuffledButtonColors[i];
      let textColor = shuffledTextColors[i];

      if (buttonColor === textColor) {
        const temp = textColor;
        textColor = shuffledTextColors[(i + 1) % 4];
        shuffledTextColors[(i + 1) % 4] = temp;
      }

      options.push({
        buttonColor,
        textColor,
        textContent: shuffledTextContents[i],
      });
    }

    return {
      prompt,
      targetColor,
      options,
    };
  }

  colorsNamespace.on("connection", (socket) => {
    console.log("🎨 Colors socket connected:", socket.id);

    socket.on("createRoom", (callback) => {
      const roomCode = generateRoomCode();
      rooms[roomCode] = {
        hostId: socket.id,
        players: {},
      };
      socket.join(roomCode);
      callback({ roomCode });
      console.log(`Room ${roomCode} created for Colors Game`);
    });

    socket.on("joinRoom", ({ roomCode, playerName }, callback) => {
      const room = rooms[roomCode];
      if (!room) return callback({ success: false });

      const isFirstPlayer = Object.keys(room.players).length === 0;

      room.players[socket.id] = {
        id: socket.id,
        name: playerName,
        score: 0,
        isVIP: isFirstPlayer,
      };

      if (isFirstPlayer) {
        room.vipId = socket.id;
      }

      socket.join(roomCode);
      colorsNamespace
        .to(roomCode)
        .emit("playersUpdate", Object.values(room.players));
      callback({ success: true, isVIP: isFirstPlayer });
      console.log(`✅ ${playerName} joined room ${roomCode}`);
    });

    socket.on("startRound", ({ roomCode }) => {
      const room = rooms[roomCode];
      if (!room) return;

      const roundData = generateRound();
      colorsNamespace.to(roomCode).emit("newRound", roundData);

      room.currentRound = roundData;
    });

    socket.on("submitAnswer", ({ roomCode, selection }, callback) => {
      const room = rooms[roomCode];
      const player = room?.players?.[socket.id];
      if (!room || !player) return;

      const correct =
        selection[room.currentRound.prompt] === room.currentRound.targetColor;
      if (correct) {
        player.score += 1;
      }

      callback({ correct });
    });

    socket.on("disconnect", () => {
      for (const code in rooms) {
        const room = rooms[code];
        if (room.players[socket.id]) {
          const name = room.players[socket.id].name;
          delete room.players[socket.id];
          colorsNamespace
            .to(code)
            .emit("playersUpdate", Object.values(room.players));
          console.log(`${name} disconnected from room ${code}`);
        }
      }
    });
  });
};
