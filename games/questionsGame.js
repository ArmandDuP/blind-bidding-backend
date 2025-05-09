module.exports = function (io) {
  const questionsNamespace = io.of("/questions");
  const rooms = {};

  const questionList = require("./questions/questionList");

  //   const questionList = [
  //     "Who is the funniest?",
  //     "Who would survive a zombie apocalypse?",
  //     "Who is the most dramatic?",
  //     "Who is most likely to forget their own birthday?",
  //     "Who is the best storyteller?",
  //   ];

  function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
  }

  function generateRoomCode() {
    return Math.random().toString(36).substr(2, 4).toUpperCase();
  }

  questionsNamespace.on("connection", (socket) => {
    console.log("✅ Questions socket connected:", socket.id);

    socket.on("createRoom", (callback) => {
      const roomCode = generateRoomCode();
      rooms[roomCode] = {
        hostId: socket.id,
        players: {},
        currentQuestion: null,
        round: 0,
        currentPlayerId: null,
        questions: [],
      };
      socket.join(roomCode);
      callback({ roomCode });
    });

    socket.on("joinRoom", ({ roomCode, playerName }, callback) => {
      const room = rooms[roomCode];
      if (!room) return callback({ success: false });

      const isFirstPlayer = Object.keys(room.players).length === 0;

      room.players[socket.id] = {
        id: socket.id,
        name: playerName,
        isVIP: isFirstPlayer,
      };

      if (isFirstPlayer) {
        room.vipId = socket.id;
      }

      socket.join(roomCode);
      questionsNamespace
        .to(roomCode)
        .emit("playersUpdate", Object.values(room.players));
      callback({ success: true, isVIP: isFirstPlayer });
      console.log(`${playerName} joined room ${roomCode}`);
    });

    socket.on("startGame", ({ roomCode }) => {
      const room = rooms[roomCode];
      if (!room) return;

      room.questions = shuffle([...questionList]);
      room.round = 0;
      const players = Object.values(room.players);
      if (players.length === 0) return;

      const randomPlayer = players[Math.floor(Math.random() * players.length)];
      room.currentPlayerId = randomPlayer.id;

      const currentQuestion = room.questions[room.round];
      questionsNamespace.to(roomCode).emit("newQuestion", {
        question: currentQuestion,
        askedBy: room.currentPlayerId,
      });
    });

    socket.on("answerQuestion", ({ roomCode, targetId }) => {
      const room = rooms[roomCode];
      if (!room) return;

      const currentQuestion = room.questions[room.round];
      const askedBy = room.currentPlayerId;

      questionsNamespace.to(roomCode).emit("questionAnswered", {
        question: currentQuestion,
        askedBy,
        answeredBy: targetId,
      });

      room.round++;
      if (room.round >= room.questions.length) {
        questionsNamespace.to(roomCode).emit("gameOver");
        return;
      }

      room.currentPlayerId = targetId;

      const nextQuestion = room.questions[room.round];
      setTimeout(
        () =>
          questionsNamespace.to(roomCode).emit("newQuestion", {
            question: nextQuestion,
            askedBy: room.currentPlayerId,
          }),
        4000
      );
    });

    socket.on("disconnect", () => {
      for (const code in rooms) {
        const room = rooms[code];
        if (room.players[socket.id]) {
          const playerName = room.players[socket.id].name;
          delete room.players[socket.id];
          questionsNamespace
            .to(code)
            .emit("playersUpdate", Object.values(room.players));
          console.log(`${playerName} disconnected from Questions room ${code}`);
        }
      }
    });
  });
};
