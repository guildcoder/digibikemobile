// server.js
const http = require('http');
const express = require('express');
const path = require('path');

const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");

const LobbyRoom = require('./rooms/LobbyRoom');
const MatchRoom = require('./rooms/MatchRoom');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

const gameServer = new Server({
  transport: new WebSocketTransport({
    server
  })
});

// register rooms
gameServer.define('lobby', LobbyRoom);
gameServer.define('match', MatchRoom);

const PORT = process.env.PORT || 2567;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
