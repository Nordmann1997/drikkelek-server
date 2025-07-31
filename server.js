const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Data Structures
const clients = new Map(); // Lagrer info om alle tilkoblede klienter
const rooms = {}; // Lagrer alle aktive spillrom

const server = http.createServer((req, res) => {
    // Enkel health check-endepunkt
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

wss.on('connection', (ws) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    clients.set(clientId, { ws, id: clientId });
    console.log(`✅ Ny klient tilkoblet: ${clientId}`);

    // Send bekreftelse til klienten med deres unike ID
    ws.send(JSON.stringify({ type: 'connected', clientId }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}:`, message.type);

            // Sjekker at klienten finnes før vi behandler meldingen
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
                case 'leave_room':
                    handleLeaveRoom(clientId);
                    break;
                case 'ping': // Svarer på ping fra klienten
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
               case 'start_spinner':
                     handleStartSpinner(clientId, message);
                     break;

                default:
                    console.log(`❓ Ukjent meldingstype: ${message.type}`);
                    sendError(clientId, `Ukjent meldingstype: ${message.type}`);
            }
        } catch (error) {
            console.error(`❌ Feil ved parsing av melding fra ${clientId}:`, error);
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
        return sendError(clientId, "Mangler 'roomId' eller 'playerName' for å opprette rom.");
    }

    if (rooms[roomId]) {
        return sendError(clientId, `Rom ${roomId} eksisterer allerede. Prøv en annen kode.`);
    }

    // Opprett det nye rommet
    rooms[roomId] = {
        id: roomId,
        hostId: clientId,
        players: {},
        createdAt: new Date(),
    };
    console.log(`🏠 Rom opprettet: ${roomId} av host ${clientId}`);
    
    // Legg til spilleren i rommet og clients-map
    addPlayerToRoom(clientId, roomId, playerName, true);
}

function handleJoinRoom(clientId, message) {
    const { roomId, playerName } = message;
    if (!roomId || !playerName) {
        return sendError(clientId, "Mangler 'roomId' eller 'playerName' for å bli med i rom.");
    }

    if (!rooms[roomId]) {
        return sendError(clientId, `Rom ${roomId} finnes ikke. Sjekk koden og prøv igjen.`);
    }
    
    // Sjekk om rommet er fullt (valgfri funksjonalitet)
    // if (Object.keys(rooms[roomId].players).length >= MAX_PLAYERS) {
    //     return sendError(clientId, `Rom ${roomId} er fullt.`);
    // }

    // Legg til spilleren i rommet
    addPlayerToRoom(clientId, roomId, playerName, false);
}

function handleLedControl(clientId, message) {
    const { targetClientId, action } = message;
    const clientInfo = clients.get(clientId);

    if (!clientInfo || !clientInfo.roomId) {
        return sendError(clientId, "Du må være i et rom for å kontrollere LED.");
    }
    
    const roomId = clientInfo.roomId;
    const room = rooms[roomId];

    if (!room || room.hostId !== clientId) {
        return sendError(clientId, "Kun host kan sende LED-kommandoer.");
    }
    
    const command = {
        type: 'led_command',
        action: action,
        fromName: clientInfo.playerName,
    };
    
    // Send til alle i rommet
    if (targetClientId === 'all') {
        console.log(`💡 Host ${clientInfo.playerName} sender '${action}' til alle i rom ${roomId}`);
        Object.keys(room.players).forEach(pId => {
            // Unngå å sende til hosten selv, da handlingen utføres lokalt
            if (pId !== clientId) { 
                sendToClient(pId, command);
            }
        });
    } 
    // Send til en spesifikk spiller
    else if (room.players[targetClientId]) {
        console.log(`💡 Host ${clientInfo.playerName} sender '${action}' til ${targetClientId} i rom ${roomId}`);
        sendToClient(targetClientId, command);
    }
}

function handleLeaveRoom(clientId) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId) return;
    
    removePlayerFromRoom(clientId, clientInfo.roomId);
}

function handleClientDisconnect(clientId) {
    handleLeaveRoom(clientId); // Samme logikk som å forlate et rom manuelt
    clients.delete(clientId);
    console.log(`🧹 Klient-data for ${clientId} er fjernet.`);
}


// --- Hjelpefunksjoner ---

function addPlayerToRoom(clientId, roomId, playerName, isHost) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo) return;

    // Oppdater info i clients-map
    clientInfo.roomId = roomId;
    clientInfo.playerName = playerName;
    clientInfo.isHost = isHost;

    // Legg spilleren til i rom-objektet
    rooms[roomId].players[clientId] = {
        id: clientId,
        name: playerName,
        isHost: isHost,
    };

    console.log(`👤 ${playerName} (${clientId}) ble med i rom ${roomId}. Host: ${isHost}`);
    
    // Send bekreftelse til spilleren
    sendToClient(clientId, { type: 'room_joined', roomId });
    
    // Send oppdatert spillerliste til alle i rommet
    broadcastRoomUpdate(roomId);
}

function removePlayerFromRoom(clientId, roomId) {
    if (!rooms[roomId] || !rooms[roomId].players[clientId]) return;

    const playerWasHost = rooms[roomId].hostId === clientId;
    const playerName = rooms[roomId].players[clientId].name;
    
    console.log(`👋 ${playerName} forlater rom ${roomId}.`);
    delete rooms[roomId].players[clientId];

    // Hvis host forlater, steng hele rommet
    if (playerWasHost) {
        console.log(`HOST FORLOT: Stenger rom ${roomId}.`);
        const roomClosedMessage = {
            type: 'error',
            message: `Host (${playerName}) forlot spillet. Rommet er stengt.`,
        };
        // Send melding til gjenværende spillere før rommet slettes
        Object.keys(rooms[roomId].players).forEach(pId => {
            sendToClient(pId, roomClosedMessage);
            const pInfo = clients.get(pId);
            if(pInfo) {
                pInfo.roomId = null;
                pInfo.isHost = false;
            }
        });
        delete rooms[roomId];
    } 
    // Hvis en vanlig spiller forlater, bare oppdater de andre
    else if (Object.keys(rooms[roomId].players).length > 0) {
        broadcastRoomUpdate(roomId);
    } 
    // Hvis det var den siste spilleren, slett rommet
    else {
        console.log(`🗑️ Sletter tomt rom: ${roomId}`);
        delete rooms[roomId];
    }
}

function broadcastRoomUpdate(roomId) {
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    const playersList = Object.values(room.players); // Inneholder nå id, name, isHost

    const updateMessage = {
        type: 'room_update',
        roomId: roomId,
        players: playersList,
    };
    
    console.log(`🔄 Sender rom-oppdatering til ${playersList.length} spillere i rom ${roomId}`);
    
    playersList.forEach(player => {
        sendToClient(player.id, updateMessage);
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
    sendToClient(clientId, {
        type: 'error',
        message: errorMessage,
    });
}

// Regelmessig opprydding av "døde" tilkoblinger
setInterval(() => {
    let cleanedCount = 0;
    clients.forEach((client, clientId) => {
        if (client.ws.readyState !== WebSocket.OPEN && client.ws.readyState !== WebSocket.CONNECTING) {
            console.log(`🧹 Renser opp inaktiv tilkobling for ${clientId}`);
            handleClientDisconnect(clientId);
            cleanedCount++;
        }
    });
    if (cleanedCount > 0) {
        console.log(`✨ Ryddet opp ${cleanedCount} inaktive tilkoblinger.`);
    }
}, 30000); // Kjører hvert 30. sekund


server.listen(PORT, () => {
    console.log(`🌐 Serveren lytter på http://localhost:${PORT}`);
});
