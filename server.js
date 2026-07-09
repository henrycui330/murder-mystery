import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all for dev
  }
});

// Game state
let players = {};
let gameState = 'lobby'; // 'lobby' or 'playing'
let gameMode = 'extended'; // 'standard' or 'extended'
let timer = 0;
let timerInterval = null;

// Config
const LOBBY_TIME = 30; // 30 seconds wait time
const ROUND_TIME = 300; // 300 seconds match time
const MIN_PLAYERS = 2; // Keep at 2 for testing

const AVAILABLE_COLORS = [
  0xff3b3b, // Vivid Red
  0x3b82f6, // Vivid Blue
  0x10b981, // Emerald Green
  0xf59e0b, // Amber Yellow
  0xec4899, // Pink
  0x8b5cf6, // Purple
  0x06b6d4, // Cyan
  0xf97316, // Orange
  0xffffff, // White
  0x78716c  // Stone Grey
];

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  players[socket.id] = {
    id: socket.id,
    name: '',
    hasJoined: false,
    x: 0,
    y: 1,
    z: 0,
    rx: 0,
    ry: 0,
    role: 'unassigned',
    isDead: false,
    isStunned: false,
    isBlinded: false,
    isEquipped: false,
    color: 0xff3b3b
  };

  // Send current state to new player
  socket.emit('init', {
    id: socket.id,
    players,
    gameState,
    gameMode,
    timer
  });

  // Handle Joining with name
  socket.on('join', (data) => {
    if (players[socket.id]) {
      players[socket.id].name = data.name || `Player ${socket.id.substring(0,4)}`;
      players[socket.id].hasJoined = true;
      
      // Assign unused color
      const usedColors = Object.values(players).filter(p => p.hasJoined && p.id !== socket.id).map(p => p.color);
      const freeColor = AVAILABLE_COLORS.find(c => !usedColors.includes(c)) || 0xff3b3b;
      players[socket.id].color = freeColor;

      if (gameState === 'playing') {
        players[socket.id].isDead = true;
        players[socket.id].role = 'spectator';
      }

      console.log(`Player ${players[socket.id].name} joined with color ${freeColor}`);
      
      // Broadcast player joined to everyone
      io.emit('playerJoined', players[socket.id]);
      checkLobby();
    }
  });

  // Handle Toggle Equip
  socket.on('toggleEquip', (equipped) => {
    if (players[socket.id] && players[socket.id].hasJoined) {
      players[socket.id].isEquipped = equipped;
      socket.broadcast.emit('playerEquipUpdated', { id: socket.id, isEquipped: equipped });
    }
  });

  // Handle Mode Change
  socket.on('setGameMode', (mode) => {
    if (gameState === 'lobby') {
      if (mode === 'standard' || mode === 'extended') {
        gameMode = mode;
        io.emit('gameModeUpdated', gameMode);
        console.log(`Game mode set to: ${gameMode}`);
      }
    }
  });

  // Handle movement
  socket.on('move', (data) => {
    const player = players[socket.id];
    if (player && player.hasJoined && !player.isDead && !player.isStunned) {
      player.x = data.x;
      player.y = data.y;
      player.z = data.z;
      player.ry = data.ry;
      socket.broadcast.emit('playerMoved', player);
    }
  });

  // Handle attacks/abilities
  socket.on('action', (data) => {
    const player = players[socket.id];
    if (!player || !player.hasJoined || player.isDead || player.isStunned || gameState !== 'playing') return;
    if (!player.isEquipped) return; // Must have weapon equipped to act

    // Broadcast the action to everyone so clients can render bullets, trails, and animations!
    io.emit('weaponFired', {
      playerId: socket.id,
      type: data.type,
      origin: data.origin,
      dir: data.dir
    });

    if (player.role === 'murderer' && data.type === 'stab') {
      const target = players[data.targetId];
      if (target && !target.isDead) {
        killPlayer(target.id);
      }
    } else if (player.role === 'sheriff' && data.type === 'shoot') {
      const target = players[data.targetId];
      if (target && !target.isDead) {
        if (target.role === 'murderer') {
          killPlayer(target.id);
        } else {
          killPlayer(player.id); // Sheriff dies if they shoot an innocent
        }
      }
    } else if (player.role === 'taser' && data.type === 'tase') {
      const target = players[data.targetId];
      if (target && !target.isDead) {
        applyStatus(target.id, 'isStunned', 5000);
      }
    } else if (player.role === 'clown' && data.type === 'pie') {
      const target = players[data.targetId];
      if (target && !target.isDead) {
        applyStatus(target.id, 'isBlinded', 5000);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    
    if (gameState === 'playing') {
      checkWinConditions();
    } else {
      checkLobby();
    }
  });
});

function applyStatus(playerId, statusKey, durationMs) {
  if (players[playerId]) {
    players[playerId][statusKey] = true;
    io.emit('statusUpdate', { id: playerId, status: statusKey, value: true });
    
    setTimeout(() => {
      if (players[playerId]) {
        players[playerId][statusKey] = false;
        io.emit('statusUpdate', { id: playerId, status: statusKey, value: false });
      }
    }, durationMs);
  }
}

function killPlayer(playerId) {
  if (players[playerId]) {
    players[playerId].isDead = true;
    io.emit('playerDied', playerId);
    checkWinConditions();
  }
}

function checkLobby() {
  const joinedPlayers = Object.values(players).filter(p => p.hasJoined);
  if (gameState === 'lobby' && joinedPlayers.length >= MIN_PLAYERS) {
    if (!timerInterval) {
      startTimer(LOBBY_TIME, startGame);
    }
  } else if (gameState === 'lobby' && joinedPlayers.length < MIN_PLAYERS) {
    stopTimer();
    timer = 0;
    io.emit('timerUpdate', timer);
  }
}

function startGame() {
  gameState = 'playing';
  
  const joinedPlayers = Object.values(players).filter(p => p.hasJoined);
  const playerIds = joinedPlayers.map(p => p.id);

  // Reset players
  playerIds.forEach(id => {
    players[id].isDead = false;
    players[id].isStunned = false;
    players[id].isBlinded = false;
    players[id].role = 'innocent';
  });

  // Shuffle players
  for (let i = playerIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
  }

  // Assign roles based on mode
  if (gameMode === 'extended') {
    if (playerIds.length >= 1) players[playerIds[0]].role = 'murderer';
    if (playerIds.length >= 2) players[playerIds[1]].role = 'sheriff';
    if (playerIds.length >= 3) players[playerIds[2]].role = 'taser';
    if (playerIds.length >= 4) players[playerIds[3]].role = 'clown';
  } else {
    // Standard mode: only murderer and sheriff
    if (playerIds.length >= 1) players[playerIds[0]].role = 'murderer';
    if (playerIds.length >= 2) players[playerIds[1]].role = 'sheriff';
  }
  
  // Send individual roles
  playerIds.forEach(id => {
    io.to(id).emit('gameStarted', { role: players[id].role, duration: ROUND_TIME });
  });

  // Broadcast position resets (spawn in house or yard)
  playerIds.forEach(id => {
    players[id].x = (Math.random() - 0.5) * 20;
    players[id].y = 1;
    players[id].z = -10 + (Math.random() - 0.5) * 10;
  });
  io.emit('stateUpdate', players);

  startTimer(ROUND_TIME, () => {
    endGame('innocents'); // Time runs out, innocents win
  });
}

function checkWinConditions() {
  if (gameState !== 'playing') return;

  const playerList = Object.values(players).filter(p => p.hasJoined);
  const alivePlayers = playerList.filter(p => !p.isDead);
  
  const isMurdererAlive = alivePlayers.some(p => p.role === 'murderer');
  
  // If murderer is dead, innocents win
  if (!isMurdererAlive) {
    return endGame('innocents');
  }

  // If ONLY the murderer is alive, murderer wins
  if (alivePlayers.length === 1 && alivePlayers[0].role === 'murderer') {
    return endGame('murderer');
  }
}

function endGame(winner) {
  gameState = 'lobby';
  stopTimer();
  
  io.emit('gameOver', { winner });
  
  // Reveal roles
  io.emit('revealRoles', players);

  setTimeout(() => {
    checkLobby(); // Restart lobby countdown
  }, 5000);
}

function startTimer(duration, onComplete) {
  timer = duration;
  io.emit('timerUpdate', timer);
  
  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(() => {
    timer--;
    io.emit('timerUpdate', timer);
    
    if (timer <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      if (onComplete) onComplete();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
