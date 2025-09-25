// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

//////////////////////////////////////
// Game config
const TICK_MS = 1000 / 20; // 20 ticks/sec
const MAX_PLAYERS = 20;
const PLAY_AREA = { w: 1200, h: 800 };
const PLAYER_SPEED = 4; // pixels per tick
const TRAIL_KEEP = 400; // keep many points (server authoritative)
const BOT_COLORS = ['cyan','magenta','yellow','lime','blue','red','green'];

//////////////////////////////////////
// Lobby / queue / matches (single match)
let queue = []; // sockets waiting to play
let players = {}; // id -> player object (in-match players + bots)
let playing = false;
let matchId = 0;
let botsCount = 0;

function rand(min, max){ return Math.random()*(max-min)+min; }
function randInt(min, max){ return Math.floor(rand(min,max+1)); }

function makePlayerObj(id, name, color, isBot=false){
  return {
    id,
    name: name || (isBot ? `BOT${++botsCount}` : `Player`),
    color: color || BOT_COLORS[Math.floor(Math.random()*BOT_COLORS.length)],
    x: rand(100, PLAY_AREA.w-100),
    y: rand(100, PLAY_AREA.h-100),
    dir: ['up','down','left','right'][randInt(0,3)],
    trail: [],
    alive: true,
    isBot,
    lastDecision: 0,
    decisionCooldown: randInt(200,600),
    ammo: 0,
  };
}

//////////////////////////////////////
// Queue management
io.on('connection', socket => {
  console.log('conn', socket.id);

  socket.on('joinQueue', ({name,color}) => {
    // add to queue (if not already)
    if(!queue.includes(socket.id)) queue.push(socket.id);
    socket.data.name = name || 'Player';
    socket.data.color = color || null;
    // notify back queue position
    socket.emit('queueUpdate', { pos: queue.indexOf(socket.id)+1, total: queue.length });
    tryStartMatch();
  });

  socket.on('leaveQueue', () => {
    queue = queue.filter(id=>id!==socket.id);
  });

  socket.on('turn', ({dir}) => {
    // server authoritative: set desired dir
    if(players[socket.id] && players[socket.id].alive){
      // only allow cardinal directions
      if(['up','down','left','right'].includes(dir)) players[socket.id].dir = dir;
    }
  });

  socket.on('disconnect', () => {
    queue = queue.filter(id=>id!==socket.id);
    // if in players, mark them dead (they disconnected)
    if(players[socket.id]){
      players[socket.id].alive = false;
      players[socket.id].disconnected = true;
    }
  });
});

function tryStartMatch(){
  // if match not running and there is at least one in queue, start a match
  if(playing) return;
  if(queue.length === 0) return;

  // Build the match: pop up to MAX_PLAYERS sockets from queue
  const inPlayers = [];
  while(inPlayers.length < Math.min(MAX_PLAYERS, queue.length)){
    inPlayers.push(queue.shift());
  }

  // start match even if fewer than MAX_PLAYERS: fill rest with bots
  players = {};
  inPlayers.forEach((sockId, idx) => {
    const sock = io.sockets.sockets.get(sockId);
    if(!sock) return;
    const p = makePlayerObj(sockId, sock.data.name || `Player${idx+1}`, sock.data.color);
    players[sockId] = p;
    sock.join('match');
    // tell client they are accepted
    sock.emit('matchStart', { id: sockId, playArea: PLAY_AREA, playersCount: MAX_PLAYERS });
  });

  // fill bots
  const neededBots = MAX_PLAYERS - Object.keys(players).length;
  for(let i=0;i<neededBots;i++){
    const botId = `bot_${Date.now()}_${i}`;
    const bot = makePlayerObj(botId, `BOT${i+1}`, BOT_COLORS[i % BOT_COLORS.length], true);
    players[botId] = bot;
  }

  playing = true;
  matchId++;
  console.log('starting match', matchId, 'players', Object.keys(players).length);
  io.in('match').emit('matchCountdown', { seconds: 4 });
  // small countdown then start
  setTimeout(()=>{ startGameLoop(); }, 4200);
}

//////////////////////////////////////
// Game loop
let gameInterval = null;
function startGameLoop(){
  if(gameInterval) clearInterval(gameInterval);
  // reset trails etc.
  Object.values(players).forEach(p=>{
    p.trail = [];
    p.alive = true;
  });
  gameInterval = setInterval(tick, TICK_MS);
}

function tick(){
  // Advance server-side logic
  const now = Date.now();
  // Move players & bots
  for(const id in players){
    const p = players[id];
    if(!p.alive) continue;

    // BOT AI: very simple — occasionally pick a random direction or try to head to a random target
    if(p.isBot){
      p.lastDecision += TICK_MS;
      if(p.lastDecision > p.decisionCooldown){
        p.lastDecision = 0;
        p.decisionCooldown = randInt(200,700);
        // choose a preferred direction away from nearest trail or to open space (simplified)
        const r = Math.random();
        if(r < 0.7){
          // random cardinal
          p.dir = ['up','down','left','right'][randInt(0,3)];
        } else {
          // try to head towards center
          p.dir = (p.x > PLAY_AREA.w/2 ? 'left' : 'right');
        }
      }
    }

    // Move
    if(p.dir === 'up') p.y -= PLAYER_SPEED;
    if(p.dir === 'down') p.y += PLAYER_SPEED;
    if(p.dir === 'left') p.x -= PLAYER_SPEED;
    if(p.dir === 'right') p.x += PLAYER_SPEED;

    // clamp to play area
    if(p.x < 0) p.x = 0;
    if(p.x > PLAY_AREA.w) p.x = PLAY_AREA.w;
    if(p.y < 0) p.y = 0;
    if(p.y > PLAY_AREA.h) p.y = PLAY_AREA.h;

    // push trail point
    p.trail.push({ x: Math.round(p.x), y: Math.round(p.y) });
    if(p.trail.length > TRAIL_KEEP) p.trail.shift();
  }

  // Collisions: simple pixel-collision check vs all trails (including own except recent)
  const allTrails = []; // array of {ownerId, x, y, indexInTrail}
  for(const id in players){
    const p = players[id];
    p.trail.forEach((pt, idx) => {
      allTrails.push({ ownerId: id, x: pt.x, y: pt.y, idx });
    });
  }

  for(const id in players){
    const p = players[id];
    if(!p.alive) continue;
    // check collision with any trail point
    for(const t of allTrails){
      if(t.ownerId === id){
        // skip the last N points to avoid instant self-collision
        const lastSafe = Math.max(0, players[id].trail.length - 10);
        if(t.idx >= lastSafe) continue;
      }
      if(Math.abs(p.x - t.x) < 6 && Math.abs(p.y - t.y) < 6){
        // collision! killer is ownerId
        p.alive = false;
        p.killer = players[t.ownerId] ? players[t.ownerId].name : null;
        break;
      }
    }
    // out-of-bounds kill (shouldn't happen due to clamp)
    if(p.x <= 0 || p.x >= PLAY_AREA.w || p.y <= 0 || p.y >= PLAY_AREA.h){
      p.alive = false;
    }
  }

  // End condition: if <=1 human+bot alive then end
  const aliveCount = Object.values(players).filter(p => p.alive).length;
  if(aliveCount <= 1){
    // send final state and stop
    io.in('match').emit('state', { players, ended: true });
    clearInterval(gameInterval);
    gameInterval = null;
    // cleanup: eject sockets from room (mark players cleared)
    for(const id in players){
      if(id.startsWith('bot_')) delete players[id];
    }
    playing = false;
    // auto-requeue connected sockets? We'll let clients re-join
    return;
  }

  // emit state (lightweight)
  // Only send minimal arrays to reduce bandwidth
  const outPlayers = {};
  for(const id in players){
    const p = players[id];
    outPlayers[id] = {
      id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, alive: p.alive,
      trail: p.trail.slice(-60) // send last bits
    };
  }
  io.in('match').emit('state', { players: outPlayers, ended: false });
}

server.listen(PORT, ()=>console.log('listening', PORT));
