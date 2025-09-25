// rooms/MatchRoom.js
const { Room } = require("colyseus");

/**
 * MatchRoom: server authoritative tick.
 * Accepts join requests only when client joins with the right matchId (provided by Lobby).
 *
 * Protocol:
 * - Clients join by calling joinOrCreate("match", { matchId, playerData })
 * - server collects players, spawns bots to fill up to MAX_PLAYERS
 * - server runs tick at 20 TPS and broadcasts 'state' messages (lightweight)
 */

const MAX_PLAYERS = 20;
const TICK_MS = 1000 / 20; // 20 ticks/s
const PLAY_AREA = { w: 1200, h: 800 };
const PLAYER_SPEED = 4;
const TRAIL_KEEP = 800;
const BOT_COLORS = ['cyan','magenta','yellow','lime','blue','red','green'];

function rand(min, max){ return Math.random()*(max-min)+min; }
function randInt(min, max){ return Math.floor(rand(min,max+1)); }

class MatchRoom extends Room {
  onCreate (options) {
    console.log("MatchRoom created with options:", options);
    this.matchId = options.matchId || ('match_direct_' + Date.now());
    this.setState({ playersCount: 0 });
    this.players = {}; // id -> player object (humans + bots)
    this.startRequested = false;
    this.tickHandler = null;
    this.clock = this.clock; // colyseus clock
    this.botCounter = 0;
    this.maxPlayers = MAX_PLAYERS;

    // Accept only if options.matchId is present (we'll validate in onAuth)
  }

  async onAuth (client, options, req) {
    // allow join only if options.matchId matches room.matchId (or matchId not provided if created directly)
    if (!options || !options.matchId) {
      // If client joined without matchId, deny (prototype enforces matchId)
      console.log('Auth failed: no matchId');
      return false;
    }
    if (options.matchId !== this.matchId) {
      console.log('Auth failed: matchId mismatch', options.matchId, '!=', this.matchId);
      return false;
    }
    return true;
  }

  onJoin (client, options) {
    console.log("Client joined match:", client.sessionId, "options:", options);
    // add player slot
    const p = {
      id: client.sessionId,
      name: (options.playerData && options.playerData.name) || `Player`,
      color: (options.playerData && options.playerData.color) || BOT_COLORS[randInt(0,BOT_COLORS.length-1)],
      x: Math.round(rand(100, PLAY_AREA.w - 100)),
      y: Math.round(rand(100, PLAY_AREA.h - 100)),
      dir: ['up','down','left','right'][randInt(0,3)],
      trail: [],
      alive: true,
      isBot: false,
      lastDecision: 0,
      decisionCooldown: randInt(200,700),
      ammo: 0,
      session: client // keep direct reference
    };
    this.players[client.sessionId] = p;
    this.setState({ playersCount: Object.keys(this.players).length });

    // when first real player joins, schedule start after short countdown
    if (!this.startRequested) {
      this.startRequested = true;
      // give 2.5s before actually starting so clients can join
      this.clock.setTimeout(() => this.startMatch(), 2500);
    }
  }

  onLeave (client, consented) {
    console.log("Client left match:", client.sessionId);
    // mark as disconnected
    const p = this.players[client.sessionId];
    if (p) {
      p.alive = false;
      p.disconnected = true;
      // keep them in state for final scoreboard; their trail still remains
    }
  }

  onDispose () {
    console.log("MatchRoom disposed");
    if (this.tickHandler) this.clock.clearInterval(this.tickHandler);
  }

  startMatch () {
    // fill bots up to MAX_PLAYERS
    const current = Object.keys(this.players).length;
    const needed = Math.max(0, this.maxPlayers - current);
    for (let i=0;i<needed;i++){
      const botId = `bot_${Date.now()}_${this.botCounter++}_${i}`;
      this.players[botId] = {
        id: botId,
        name: `BOT${i+1}`,
        color: BOT_COLORS[i % BOT_COLORS.length],
        x: Math.round(rand(100, PLAY_AREA.w - 100)),
        y: Math.round(rand(100, PLAY_AREA.h - 100)),
        dir: ['up','down','left','right'][randInt(0,3)],
        trail: [],
        alive: true,
        isBot: true,
        lastDecision: 0,
        decisionCooldown: randInt(200,700),
      };
    }

    // start tick
    this.tickHandler = this.clock.setInterval(() => this._tick(TICK_MS), TICK_MS);

    // broadcast start
    this.broadcast("matchStarted", { playArea: PLAY_AREA, playersCount: MAX_PLAYERS });
  }

  _tick(delta) {
    // Move players and bots
    for (const id in this.players) {
      const p = this.players[id];
      if (!p.alive) continue;

      if (p.isBot) {
        p.lastDecision += delta;
        if (p.lastDecision > p.decisionCooldown) {
          p.lastDecision = 0;
          p.decisionCooldown = randInt(200,700);
          // simple AI that avoids immediate collisions using a quick occupancy map
          // choose random safe direction preferring current direction
          const directions = ['up','down','left','right'];
          // prefer current dir
          directions.unshift(p.dir);
          let chosen = null;
          for (let d of directions) {
            const nx = p.x + (d==='left'?-PLAYER_SPEED:d==='right'?PLAYER_SPEED:0);
            const ny = p.y + (d==='up'?-PLAYER_SPEED:d==='down'?PLAYER_SPEED:0);
            // check inside play area
            if (nx < 0 || nx > PLAY_AREA.w || ny < 0 || ny > PLAY_AREA.h) continue;
            // quick check: avoid own most recent trail points
            let danger=false;
            for (const otherId in this.players) {
              const other = this.players[otherId];
              if (!other || !other.trail) continue;
              for (let ti = 0; ti<other.trail.length; ti+=4) {
                const t = other.trail[ti];
                if (!t) continue;
                if (Math.abs(nx - t.x) < 8 && Math.abs(ny - t.y) < 8) {
                  // if it's own trail, skip last few points
                  if (otherId === id && ti >= Math.max(0, other.trail.length - 10)) continue;
                  danger = true;
                  break;
                }
              }
              if (danger) break;
            }
            if (!danger) { chosen = d; break; }
          }
          if (chosen) p.dir = chosen;
        }
      }

      // move by dir
      if (p.dir === 'up') p.y -= PLAYER_SPEED;
      if (p.dir === 'down') p.y += PLAYER_SPEED;
      if (p.dir === 'left') p.x -= PLAYER_SPEED;
      if (p.dir === 'right') p.x += PLAYER_SPEED;

      // clamp
      p.x = Math.max(0, Math.min(PLAY_AREA.w, p.x));
      p.y = Math.max(0, Math.min(PLAY_AREA.h, p.y));

      // push trail
      p.trail.push({ x: Math.round(p.x), y: Math.round(p.y) });
      if (p.trail.length > TRAIL_KEEP) p.trail.shift();
    }

    // Build quick trail index for collision checks (hash grid)
    const occupancy = new Map(); // key = `${x|y}` with cell size
    const CELL = 6;
    for (const id in this.players) {
      const p = this.players[id];
      for (let i=0;i<p.trail.length;i++){
        const pt = p.trail[i];
        const key = `${Math.floor(pt.x / CELL)}|${Math.floor(pt.y / CELL)}`;
        if (!occupancy.has(key)) occupancy.set(key, []);
        occupancy.get(key).push({ ownerId: id, idx: i, x: pt.x, y: pt.y });
      }
    }

    // collisions
    for (const id in this.players) {
      const p = this.players[id];
      if (!p.alive) continue;
      const key = `${Math.floor(p.x / CELL)}|${Math.floor(p.y / CELL)}`;
      const bucket = occupancy.get(key);
      if (!bucket) continue;
      for (const t of bucket) {
        // skip collision with very recent own trail
        if (t.ownerId === id) {
          const lastSafe = Math.max(0, this.players[id].trail.length - 10);
          if (t.idx >= lastSafe) continue;
        }
        if (Math.abs(p.x - t.x) < 6 && Math.abs(p.y - t.y) < 6) {
          // hit
          p.alive = false;
          p.killer = this.players[t.ownerId] ? this.players[t.ownerId].name : null;
          break;
        }
      }
    }

    // Check end condition
    const alivePlayers = Object.values(this.players).filter(p => p.alive);
    if (alivePlayers.length <= 1) {
      // end match
      this.broadcast("state", { players: this._exportState(), ended: true });
      if (this.tickHandler) this.clock.clearInterval(this.tickHandler);
      this.roomLocked = true;
      // schedule dispose in a few seconds
      this.clock.setTimeout(() => this.disconnect(), 3000);
      return;
    }

    // otherwise broadcast state snapshot (lightweight)
    this.broadcast("state", { players: this._exportState(), ended: false });
  }

  _exportState () {
    // send minimal state to clients
    const out = {};
    for (const id in this.players) {
      const p = this.players[id];
      out[id] = {
        id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y),
        dir: p.dir, alive: p.alive, trail: p.trail.slice(-120), isBot: p.isBot
      };
    }
    return out;
  }
}

module.exports = MatchRoom;
