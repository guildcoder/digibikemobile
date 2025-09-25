// client.js
const Colyseus = window.colyseus;
const client = new Colyseus.Client(window.location.origin.replace(/^http/, 'ws'));

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = canvas.width = window.innerWidth;
let H = canvas.height = window.innerHeight;
window.addEventListener('resize', ()=>{W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;});

const nameInput = document.getElementById('name');
const queueBtn = document.getElementById('queueBtn');
const status = document.getElementById('status');

let lobbyRoom = null;
let matchRoom = null;
let localPlayerId = null;
let gameState = null;
let inQueue = false;

queueBtn.onclick = async () => {
  if (!inQueue) {
    // join the lobby and get queued
    try {
      lobbyRoom = await client.joinOrCreate('lobby', { name: nameInput.value });
      status.innerText = 'Queued';
      queueBtn.innerText = 'Leave Queue';
      inQueue = true;

      lobbyRoom.onMessage('queueUpdate', m => {
        status.innerText = `Queue: ${m.pos}/${m.total}`;
      });

      lobbyRoom.onMessage('matchCreated', async (m) => {
        // server told us to join a match
        try {
          // leave lobby
          lobbyRoom.leave();
          inQueue = false;
          queueBtn.innerText = 'Join Queue';
          status.innerText = 'Joining match...';

          // join match room with matchId and playerData
          matchRoom = await client.joinOrCreate('match', { matchId: m.matchId, playerData: m.playerData });
          localPlayerId = m.playerData.sessionId;
          setupMatchHandlers();
        } catch (err) {
          console.error('join match error', err);
        }
      });

    } catch (err) {
      console.error('lobby join error', err);
      status.innerText = 'Could not join lobby';
    }

  } else {
    // leave lobby
    if (lobbyRoom) {
      await lobbyRoom.leave();
      lobbyRoom = null;
    }
    queueBtn.innerText = 'Join Queue';
    status.innerText = 'Left queue';
    inQueue = false;
  }
};

async function setupMatchHandlers() {
  if (!matchRoom) return;
  status.innerText = 'In match (waiting)...';

  matchRoom.onMessage('matchStarted', (m) => {
    status.innerText = 'Match started!';
  });

  matchRoom.onMessage('state', (s) => {
    gameState = s;
    if (s.ended) {
      status.innerText = 'Match ended';
      // show winner briefly
      setTimeout(()=>{
        // after match end, navigate back to lobby
        status.innerText = 'Join queue to play again';
      }, 1200);
    }
  });

  // allow tapping/mouse to turn
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    handleTap(t.clientX, t.clientY);
  }, {passive:false});

  canvas.addEventListener('mousedown', (e) => {
    handleTap(e.clientX, e.clientY);
  });

  function handleTap(cx, cy) {
    if (!gameState || !localPlayerId) return;
    const players = gameState.players || {};
    const me = players[localPlayerId];
    if (!me || !me.alive) return;
    const camX = me.x - W/2;
    const camY = me.y - H/2;
    const worldTapX = camX + cx;
    const worldTapY = camY + cy;
    const dx = worldTapX - me.x;
    const dy = worldTapY - me.y;
    const dir = (Math.abs(dx) > Math.abs(dy)) ? (dx>0?'right':'left') : (dy>0?'down':'up');
    matchRoom.send({ type: 'turn', dir }); // room will receive and set direction if authorized
  }

  // send inputs: we'll implement light client prediction by sending 'turn' messages only on taps
  // handle server messages already (server authoritative state broadcast)
}

function draw() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,W,H);

  if (!gameState || !gameState.players) {
    ctx.fillStyle='white'; ctx.fillText('Waiting for match...', 20, 40);
    requestAnimationFrame(draw); return;
  }

  const players = gameState.players;
  const me = players[localPlayerId] || Object.values(players)[0];
  if (!me) {
    ctx.fillStyle='white'; ctx.fillText('No local player state yet...', 20, 40);
    requestAnimationFrame(draw); return;
  }
  const camX = me.x - W/2;
  const camY = me.y - H/2;

  // trails
  for (const id in players) {
    const p = players[id];
    ctx.fillStyle = p.color || 'cyan';
    for (const pt of p.trail) {
      ctx.fillRect(pt.x - camX - 2, pt.y - camY - 2, 4, 4);
    }
  }

  // players
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    ctx.fillStyle = p.color || 'cyan';
    ctx.fillRect(p.x - camX - 8, p.y - camY - 8, 16, 16);
    ctx.fillStyle = '#fff';
    ctx.font = '14px monospace';
    ctx.fillText(p.name, p.x - camX - ctx.measureText(p.name).width/2, p.y - camY - 12);
  }

  // HUD
  ctx.fillStyle='rgba(0,0,0,0.6)';
  ctx.fillRect(8, H-56, 220, 48);
  ctx.fillStyle='white';
  const alive = Object.values(players).filter(p=>p.alive).length;
  ctx.fillText(`Alive: ${alive}`, 16, H-36);
  ctx.fillText(`You: ${me ? me.name : '---'}`, 16, H-18);

  requestAnimationFrame(draw);
}
draw();
