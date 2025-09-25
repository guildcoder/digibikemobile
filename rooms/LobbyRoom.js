// rooms/LobbyRoom.js
const { Room } = require("colyseus");

const MAX_PLAYERS_PER_MATCH = 20;
const COUNTDOWN_MS = 5000; // start match countdown when first player joins (if you want)

class LobbyRoom extends Room {
  onCreate (options) {
    console.log("LobbyRoom created");
    this.setState({ queue: [] });
    this.queue = []; // array of client.sessionId
    this.matchCounter = 0;

    // optional: every 2 seconds attempt to start matches if queue >=1
    this.matchInterval = this.clock.setInterval(() => {
      this.attemptStartMatch();
    }, 2000);
  }

  onJoin (client, options) {
    console.log("Client joined lobby:", client.sessionId);
    // track minimal data for queue position
    this.queue.push({ sessionId: client.sessionId, name: options.name || 'Player', color: options.color || null });
    this.setState({ queue: this.queue.map(p => ({ id: p.sessionId, name: p.name })) });
    // notify client of position
    client.send("queueUpdate", { pos: this.queue.findIndex(p => p.sessionId === client.sessionId) + 1, total: this.queue.length });
  }

  onLeave (client, consented) {
    console.log("Client left lobby:", client.sessionId);
    this.queue = this.queue.filter(q => q.sessionId !== client.sessionId);
    this.setState({ queue: this.queue.map(p => ({ id: p.sessionId, name: p.name })) });
  }

  onDispose () {
    console.log("LobbyRoom disposed");
    this.clock.clearInterval(this.matchInterval);
  }

  attemptStartMatch () {
    // If no players => skip
    if (this.queue.length === 0) return;

    // We'll create a match immediately when either:
    // - queue length >= MAX_PLAYERS_PER_MATCH (full)
    // - OR queue length > 0 and oldest has waited long enough (simple demo: start when at least 1 exists)
    // For prototype, start match when at least 1 queued client and create match immediately.
    // Pull up to MAX_PLAYERS_PER_MATCH
    const playersForMatch = this.queue.splice(0, MAX_PLAYERS_PER_MATCH);
    if (playersForMatch.length === 0) return;

    const matchId = `match_${Date.now()}_${this.matchCounter++}`;

    // Tell each queued client to join a match room with a matchId option
    playersForMatch.forEach(item => {
      // find the Client object for sessionId
      const client = this.clients.find(c => c.sessionId === item.sessionId);
      if (client) {
        // instruct client to join match by passing matchId and player data
        client.send("matchCreated", {
          roomName: "match",
          matchId,
          playerData: { sessionId: client.sessionId, name: item.name, color: item.color }
        });
      } else {
        // client might have disconnected; it will be dropped
      }
    });

    // update queue state broadcast
    this.setState({ queue: this.queue.map(p => ({ id: p.sessionId, name: p.name })) });
  }
}

module.exports = LobbyRoom;
