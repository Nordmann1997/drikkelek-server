const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Data Structures
const clients = new Map(); // Lagrer info om alle tilkoblede klienter (ws, id, roomId, playerName, isHost)
const rooms = {};   // Lagrer alle aktive spillrom (id, hostId, players)

// Enkel HTTP-server for health checks og for å knytte WebSocket-serveren til
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'healthy', 
            clients: clients.size,
            rooms: Object.keys(rooms).length,
            uptime: process.uptime()
        }));
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

    // Send bekreftelse til klienten med deres unike ID
    ws.send(JSON.stringify({ type: 'connected', clientId }));

    // Lytter på meldinger fra denne spesifikke klienten
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}: ${message.type}`);

            if (!clients.has(clientId)) return;

            // Ruter meldingen til riktig håndteringsfunksjon
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
                    console.log(`❓ Ukjent meldingstype: ${message.type}`);
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

    ws.on('error', (error) => {
        console.error(`💥 WebSocket feil for ${clientId}:`, error);
    });
});

// --- Kjernefunksjoner ---

function handleCreateRoom(clientId, message) {
    const { roomId, playerName } = message;
    if (!roomId || !playerName) {
        return sendError(clientId, "Mangler informasjon for å opprette rom.");
    }
    if (rooms[roomId]) {
        return sendError(clientId, `Rom ${roomId} eksisterer allerede.`);
    }

    rooms[roomId] = { id: roomId, hostId: clientId, players: {} };
    console.log(`🏠 Rom opprettet: ${roomId} av host ${clientId}`);
    
    addPlayerToRoom(clientId, roomId, playerName, true);
}

function handleJoinRoom(clientId, message) {
    const { roomId, playerName } = message;
    if (!roomId || !playerName) {
        return sendError(clientId, "Mangler informasjon for å bli med i rom.");
    }
    if (!rooms[roomId]) {
        return sendError(clientId, `Rom ${roomId} finnes ikke.`);
    }

    addPlayerToRoom(clientId, roomId, playerName, false);
}

function handleLedControl(clientId, message) {
    const { targetClientId, action } = message;
    const clientInfo = clients.get(clientId);

    if (!clientInfo || !clientInfo.roomId) return;
    
    const room = rooms[clientInfo.roomId];
    if (!room || room.hostId !== clientId) {
        return sendError(clientId, "Kun host kan sende LED-kommandoer.");
    }
    
    const command = { type: 'led_command', action, fromName: clientInfo.playerName };
    
    if (targetClientId === 'all') {
        Object.keys(room.players).forEach(pId => {
            if (pId !== clientId) sendToClient(pId, command);
        });
    } else if (room.players[targetClientId]) {
        sendToClient(targetClientId, command);
    }
}

function handleStartSpinner(clientId, message) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId || !clientInfo.isHost) {
        return sendError(clientId, "Kun host kan starte spinneren.");
    }
    
    const roomId = clientInfo.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (Object.keys(room.players).length < 2) {
        return sendError(clientId, "Trenger minst 2 spillere for å spinne.");
    }
    
    console.log(`🎰 Spinner startet av ${clientInfo.playerName} i rom ${roomId}`);
    
    const playerIds = Object.keys(room.players);
    const playerOrder = playerIds.sort(() => Math.random() - 0.5);
    
    const totalSpins = 3 + Math.random() * 2;
    const totalSteps = Math.floor(totalSpins * playerOrder.length);
    const selectedIndex = Math.floor(Math.random() * playerOrder.length);
    const finalStep = totalSteps + selectedIndex;
    
    const winnerDuration = (message.winnerDuration || 5) * 1000;
    
    broadcastToRoom(roomId, { type: 'spinner_start' });
    startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration);
}

function startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration) {
    const room = rooms[roomId];
    if (!room) return;
    
    let currentStep = 0;
    let currentPlayerIndex = 0;
    let interval = 100;
    
    const spinStep = () => {
        if (!rooms[roomId]) return; // Sjekk om rommet ble lukket underveis

        if (currentStep >= finalStep) {
            const winnerId = playerOrder[currentPlayerIndex];
            const winner = room.players[winnerId];
            if (!winner) return console.error("Spinner landet på en ugyldig spiller.");

            console.log(`🏆 Spinner ferdig! Vinner: ${winner.name}`);
            
            broadcastToRoom(roomId, { type: 'spinner_result', winnerId: winner.id });
            sendToClient(winnerId, { type: 'led_command', action: 'winner_highlight', duration: winnerDuration });
            return;
        }
        
        const highlightedPlayerId = playerOrder[currentPlayerIndex];
        broadcastToRoom(roomId, { type: 'spinner_highlight', highlightedPlayerId });
        
        currentStep++;
        currentPlayerIndex = (currentPlayerIndex + 1) % playerOrder.length;
        interval = 100 + (600 * Math.pow(currentStep / finalStep, 2));
        
        setTimeout(spinStep, interval);
    };
    
    spinStep();
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

// --- Hjelpefunksjoner ---

function addPlayerToRoom(clientId, roomId, playerName, isHost) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo) return;

    clientInfo.roomId = roomId;
    clientInfo.playerName = playerName;
    clientInfo.isHost = isHost;

    rooms[roomId].players[clientId] = { id: clientId, name: playerName, isHost };

    console.log(`👤 ${playerName} (${clientId}) ble med i rom ${roomId}. Host: ${isHost}`);
    
    sendToClient(clientId, { type: 'room_joined', roomId });
    broadcastRoomUpdate(roomId);
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
        broadcastRoomUpdate(roomId);
    } else {
        console.log(`🗑️ Sletter tomt rom: ${roomId}`);
        delete rooms[roomId];
    }
}

function broadcastRoomUpdate(roomId) {
    if (!rooms[roomId]) return;
    const playersList = Object.values(rooms[roomId].players);
    broadcastToRoom(roomId, { type: 'room_update', players: playersList });
    console.log(`🔄 Sender rom-oppdatering til ${playersList.length} spillere.`);
}

function broadcastToRoom(roomId, message) {
    if (!rooms[roomId]) return;
    Object.keys(rooms[roomId].players).forEach(pId => sendToClient(pId, message));
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

// Starter serveren
server.listen(PORT, () => {
    console.log(`🌐 Serveren lytter på http://localhost:${PORT}`);
});
