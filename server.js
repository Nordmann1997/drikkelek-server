const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Data Structures
const clients = new Map();
const rooms = {};

// HTTP Server for health checks
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', clients: clients.size, rooms: Object.keys(rooms).length }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Drikkelek WebSocket Server is running!');
    }
});

const wss = new WebSocket.Server({ server });

console.log(`🚀 Drikkelek Server startet på port ${PORT}`);

// Hoved-lytter for nye tilkoblinger
wss.on('connection', (ws) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    clients.set(clientId, { ws, id: clientId });
    console.log(`✅ Ny klient tilkoblet: ${clientId}`);
    ws.send(JSON.stringify({ type: 'connected', clientId }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}: ${message.type}`);
            if (!clients.has(clientId)) return;

            switch (message.type) {
                case 'create_room':
                    handleCreateRoom(clientId, message);
                    break;
                case 'join_room':
                    handleJoinRoom(clientId, message);
                    break;
                case 'control_led':
                    handleLedControl(clientId, message);
                    break;
                case 'start_game':
                    handleStartGame(clientId, message);
                    break;
                case 'start_spinner':
                    handleStartSpinner(clientId, message);
                    break;
                case 'leave_room':
                    handleLeaveRoom(clientId);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                default:
                    sendError(clientId, `Ukjent meldingstype: ${message.type}`);
            }
        } catch (error) {
            console.error(`❌ Feil ved behandling av melding fra ${clientId}:`, error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Klient frakoblet: ${clientId}`);
        handleClientDisconnect(clientId);
    });
});


// --- Kjernefunksjoner for spillflyt ---

function handleCreateRoom(clientId, message) {
    const { roomId, playerName } = message;
    if (!roomId || !playerName) return sendError(clientId, "Mangler informasjon for å opprette rom.");
    if (rooms[roomId]) return sendError(clientId, `Rom ${roomId} eksisterer allerede.`);

    rooms[roomId] = { id: roomId, hostId: clientId, players: {} };
    console.log(`🏠 Rom opprettet: ${roomId} av host ${clientId}`);
    addPlayerToRoom(clientId, roomId, playerName, true);
}

function handleJoinRoom(clientId, message) {
    const { roomId, playerName } = message;
    if (!roomId || !playerName) return sendError(clientId, "Mangler informasjon for å bli med i rom.");
    if (!rooms[roomId]) return sendError(clientId, `Rom ${roomId} finnes ikke.`);
    addPlayerToRoom(clientId, roomId, playerName, false);
}

function handleStartGame(clientId, message) {
    const { roomId, gameType } = message;
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.isHost) return sendError(clientId, "Kun host kan starte et spill.");
    if (!roomId || !gameType) return sendError(clientId, "Mangler informasjon for å starte spillet.");
    
    console.log(`🎮 Host ${clientInfo.playerName} starter spillet '${gameType}' i rom ${roomId}.`);
    broadcastToRoom(roomId, { type: 'game_started', gameType }, clientId);
}

function handleLeaveRoom(clientId) {
    const clientInfo = clients.get(clientId);
    if (clientInfo && clientInfo.roomId) {
        removePlayerFromRoom(clientId, clientInfo.roomId);
    }
}

function handleClientDisconnect(clientId) {
    handleLeaveRoom(clientId);
    clients.delete(clientId);
    console.log(`🧹 Klient-data for ${clientId} er fjernet.`);
}


// --- Spill-spesifikke funksjoner ---

function handleLedControl(clientId, message) {
    const { targetClientId, action } = message;
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId || !clientInfo.isHost) return sendError(clientId, "Kun host kan sende kommandoer.");
    
    const room = rooms[clientInfo.roomId];
    if (!room) return;

    const command = { type: 'led_command', action };
    if (targetClientId === 'all') {
        broadcastToRoom(room.id, command, clientId);
    } else if (room.players[targetClientId]) {
        sendToClient(targetClientId, command);
    }
}

function handleStartSpinner(clientId, message) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId) return sendError(clientId, "Må være i et rom for å spinne.");

    const room = rooms[clientInfo.roomId];
    if (!room) return;
    if (Object.keys(room.players).length < 2) return sendError(clientId, "Trenger minst 2 spillere.");

    const playerIds = Object.keys(room.players).sort(() => Math.random() - 0.5);
    const finalStep = Math.floor((3 + Math.random() * 2) * playerIds.length) + Math.floor(Math.random() * playerIds.length);
    const winnerDuration = (message.winnerDuration || 5) * 1000;
    
    broadcastToRoom(room.id, { type: 'spinner_start' });
    startSpinnerAnimation(room.id, playerIds, finalStep, winnerDuration);
}

function startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration) {
    const room = rooms[roomId];
    if (!room) return;
    
    let currentStep = 0, index = 0, interval = 100;

    const spinStep = () => {
        if (!rooms[roomId]) return;
        if (currentStep >= finalStep) {
            const winnerId = playerOrder[index];
            if (!room.players[winnerId]) return;
            broadcastToRoom(roomId, { type: 'spinner_result', winnerId });
            sendToClient(winnerId, { type: 'led_command', action: 'winner_highlight', duration: winnerDuration });
            return;
        }
        broadcastToRoom(roomId, { type: 'spinner_highlight', highlightedPlayerId: playerOrder[index] });
        currentStep++;
        index = (index + 1) % playerOrder.length;
        interval = 100 + (600 * Math.pow(currentStep / finalStep, 2));
        setTimeout(spinStep, interval);
    };
    spinStep();
}


// --- Hjelpefunksjoner ---

function addPlayerToRoom(clientId, roomId, playerName, isHost) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !rooms[roomId]) return;

    Object.assign(clientInfo, { roomId, playerName, isHost });
    rooms[roomId].players[clientId] = { id: clientId, name: playerName, isHost };

    console.log(`👤 ${playerName} (${clientId}) ble med i rom ${roomId}. Host: ${isHost}`);
    
    sendToClient(clientId, { type: 'room_joined', roomId });
    const playersList = Object.values(rooms[roomId].players);
    broadcastToRoom(roomId, { type: 'room_update', players: playersList });
}

function removePlayerFromRoom(clientId, roomId) {
    const room = rooms[roomId];
    if (!room || !room.players[clientId]) return;

    const playerWasHost = room.hostId === clientId;
    const playerName = room.players[clientId].name;
    
    console.log(`👋 ${playerName} forlater rom ${roomId}.`);
    delete room.players[clientId];

    if (playerWasHost) {
        console.log(`HOST FORLOT: Stenger rom ${roomId}.`);
        broadcastToRoom(roomId, { type: 'error', message: `Host (${playerName}) forlot spillet. Rommet er stengt.` });
        Object.keys(room.players).forEach(pId => {
            const pInfo = clients.get(pId);
            if (pInfo) { pInfo.roomId = null; pInfo.isHost = false; }
        });
        delete rooms[roomId];
    } else if (Object.keys(room.players).length > 0) {
        // HER ER DEN VIKTIGE ENDRINGEN: Vi bygger meldingen og kaller den generelle funksjonen.
        const playersList = Object.values(room.players);
        broadcastToRoom(roomId, { type: 'room_update', players: playersList });
        console.log(`🔄 Sender rom-oppdatering etter at en spiller forlot.`);
    } else {
        console.log(`🗑️ Sletter tomt rom: ${roomId}`);
        delete rooms[roomId];
    }
}

/**
 * Sender en melding til alle spillere i et spesifikt rom.
 * @param {string} roomId - ID-en til rommet.
 * @param {object} message - Meldingsobjektet som skal sendes.
 * @param {string|null} excludeClientId - (Valgfri) ID-en til en klient som IKKE skal motta meldingen.
 */
function broadcastToRoom(roomId, message, excludeClientId = null) {
    if (!rooms[roomId]) return;
    Object.keys(rooms[roomId].players).forEach(pId => {
        if (pId !== excludeClientId) {
            sendToClient(pId, message);
        }
    });
}

function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}

function sendError(clientId, errorMessage) {
    console.log(`❌ Sender feilmelding til ${clientId}: ${errorMessage}`);
    sendToClient(clientId, { type: 'error', message: errorMessage });
}


// --- Server Oppstart ---
server.listen(PORT, () => {
    console.log(`🌐 Serveren lytter på http://localhost:${PORT}`);
});
