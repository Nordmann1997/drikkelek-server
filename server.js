const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const clients = new Map();
const rooms = {};

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
                // NYE BOMBESPILL HANDLERS
                case 'roll_dice':
                    handleRollDice(clientId, message);
                    break;
                case 'use_bomb':
                    handleUseBomb(clientId, message);
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

// --- Spillflyt ---

function handleCreateRoom(clientId, message) {
    const { roomId, playerName, avatar } = message;
    if (!roomId || !playerName) return sendError(clientId, "Mangler informasjon for å opprette rom.");
    if (rooms[roomId]) return sendError(clientId, `Rom ${roomId} eksisterer allerede.`);
    rooms[roomId] = { id: roomId, hostId: clientId, players: {}, gameSettings: null, currentGame: null };
    console.log(`🏠 Rom opprettet: ${roomId} av host ${clientId}`);
    addPlayerToRoom(clientId, roomId, playerName, true, avatar);
}

function handleJoinRoom(clientId, message) {
    const { roomId, playerName, avatar } = message;
    if (!roomId || !playerName) return sendError(clientId, "Mangler informasjon for å bli med i rom.");
    if (!rooms[roomId]) return sendError(clientId, `Rom ${roomId} finnes ikke.`);
    addPlayerToRoom(clientId, roomId, playerName, false, avatar);
}

function handleStartGame(clientId, message) {
    const { roomId, gameType, gameSettings } = message;
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.isHost) return sendError(clientId, "Kun host kan starte et spill.");
    if (!roomId || !gameType) return sendError(clientId, "Mangler informasjon for å starte spillet.");
    
    const room = rooms[roomId];
    if (!room) return sendError(clientId, "Rom finnes ikke.");
    
    // Lagre spillinnstillinger og spilltype
    room.gameSettings = gameSettings || {};
    room.currentGame = gameType;
    
    console.log(`🎮 Host ${clientInfo.playerName} starter spillet '${gameType}' i rom ${roomId} med innstillinger:`, gameSettings);
    
    // Initialiser spill-spesifikk data
    if (gameType === 'bomb_game') {
        initializeBombGame(room);
    }
    
    // Send game_started med spillerdata
    const playersData = Object.values(room.players).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isHost: p.isHost,
        points: p.points || 0,
        diceValue: p.diceValue || 1,
        hasBomb: p.hasBomb || false
    }));
    
    broadcastToRoom(roomId, { 
        type: 'game_started', 
        gameType,
        players: playersData
    });
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

// --- Bombespill-logikk ---

function initializeBombGame(room) {
    console.log(`💣 Initialiserer bombespill for rom ${room.id}`);
    
    // Sett default verdier fra gameSettings eller fallback
    const settings = room.gameSettings || {};
    room.bombGameSettings = {
        pointsForBomb: settings.pointsForBomb || 15,
        bombDamagePercent: settings.bombDamagePercent || 50,
        maxPoints: settings.maxPoints || 100,
        enableWinCondition: settings.enableWinCondition !== false
    };
    
    // Initialiser alle spillere
    Object.values(room.players).forEach(player => {
        player.points = 0;
        player.diceValue = 1;
        player.hasBomb = false;
    });
    
    console.log(`✅ Bombespill initialisert med innstillinger:`, room.bombGameSettings);
}

function handleRollDice(clientId, message) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId) return sendError(clientId, "Må være i et rom for å kaste terning.");
    
    const room = rooms[clientInfo.roomId];
    if (!room || room.currentGame !== 'bomb_game') return sendError(clientId, "Ikke i et bombespill.");
    
    const player = room.players[clientId];
    if (!player) return sendError(clientId, "Spiller ikke funnet.");
    
    // Spilleren kan ikke kaste terning hvis de har en bombe
    if (player.hasBomb) return sendError(clientId, "Kan ikke kaste terning når du har en bombe.");
    
    // Kast terning (1-6)
    const diceValue = Math.floor(Math.random() * 6) + 1;
    player.diceValue = diceValue;
    player.points = (player.points || 0) + diceValue;
    
    console.log(`🎲 ${player.name} kastet ${diceValue}, har nå ${player.points} poeng`);
    
    // Send dice_rolled til alle spillere
    const playersData = Object.values(room.players).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isHost: p.isHost,
        points: p.points || 0,
        diceValue: p.diceValue || 1,
        hasBomb: p.hasBomb || false
    }));
    
    broadcastToRoom(room.id, {
        type: 'dice_rolled',
        playerId: clientId,
        diceValue: diceValue,
        newPoints: player.points,
        players: playersData
    });
    
    // Sjekk om spilleren skal få en bombe
    checkForBombAvailability(room, clientId);
    
    // Sjekk for vinner
    checkForWinner(room);
}

function handleUseBomb(clientId, message) {
    const { targetId } = message;
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.roomId) return sendError(clientId, "Må være i et rom for å bruke bombe.");
    
    const room = rooms[clientInfo.roomId];
    if (!room || room.currentGame !== 'bomb_game') return sendError(clientId, "Ikke i et bombespill.");
    
    const bomber = room.players[clientId];
    const target = room.players[targetId];
    
    if (!bomber || !target) return sendError(clientId, "Spiller ikke funnet.");
    if (!bomber.hasBomb) return sendError(clientId, "Du har ikke en bombe.");
    if (targetId === clientId) return sendError(clientId, "Kan ikke bombe seg selv.");
    
    console.log(`💥 ${bomber.name} bomber ${target.name}!`);
    
    // Beregn skade
    const damage = Math.floor((target.points || 0) * (room.bombGameSettings.bombDamagePercent / 100));
    target.points = Math.max(0, (target.points || 0) - damage);
    
    // Fjern bomben fra bomberen
    bomber.hasBomb = false;
    
    console.log(`💔 ${target.name} mister ${damage} poeng og har nå ${target.points} poeng`);
    
    // Send bomb_used til alle spillere
    const playersData = Object.values(room.players).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isHost: p.isHost,
        points: p.points || 0,
        diceValue: p.diceValue || 1,
        hasBomb: p.hasBomb || false
    }));
    
    broadcastToRoom(room.id, {
        type: 'bomb_used',
        bomberId: clientId,
        targetId: targetId,
        damage: damage,
        targetNewPoints: target.points,
        players: playersData
    });
}

function checkForBombAvailability(room, playerId) {
    const player = room.players[playerId];
    if (!player || !room.bombGameSettings) return false;
    
    // Sjekk om spilleren har nok poeng for bombe og ikke allerede har en
    if (player.points >= room.bombGameSettings.pointsForBomb && !player.hasBomb) {
        player.hasBomb = true;
        
        // IKKE reset poeng når man får bombe - la spilleren beholde dem
        // player.points = 0; // FJERNET DENNE LINJEN
        
        console.log(`💣 ${player.name} har fått en bombe! (${player.points} poeng)`);
        
        const playersData = Object.values(room.players).map(p => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            isHost: p.isHost,
            points: p.points || 0,
            diceValue: p.diceValue || 1,
            hasBomb: p.hasBomb || false
        }));
        
        broadcastToRoom(room.id, {
            type: 'bomb_available',
            playerId: playerId,
            players: playersData
        });
        
        return true;
    }
    
    return false;
}

function checkForWinner(room) {
    if (!room.bombGameSettings || !room.bombGameSettings.enableWinCondition) return null;
    
    const winner = Object.values(room.players).find(p => (p.points || 0) >= room.bombGameSettings.maxPoints);
    if (winner) {
        console.log(`🏆 ${winner.name} vant spillet med ${winner.points} poeng!`);
        
        const playersData = Object.values(room.players).map(p => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            isHost: p.isHost,
            points: p.points || 0,
            diceValue: p.diceValue || 1,
            hasBomb: p.hasBomb || false
        }));
        
        broadcastToRoom(room.id, {
            type: 'game_winner',
            winnerId: winner.id,
            players: playersData
        });
        
        return winner;
    }
    
    return null;
}

// --- Spinner spill-logikk (eksisterende) ---

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

function addPlayerToRoom(clientId, roomId, playerName, isHost, avatar) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !rooms[roomId]) return;
    Object.assign(clientInfo, { roomId, playerName, isHost, avatar });
    rooms[roomId].players[clientId] = { 
        id: clientId, 
        name: playerName, 
        isHost, 
        avatar,
        points: 0,
        diceValue: 1,
        hasBomb: false
    };
    console.log(`👤 ${playerName} (${clientId}) ble med i rom ${roomId} med avatar.`);
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
        const playersList = Object.values(room.players);
        broadcastToRoom(roomId, { type: 'room_update', players: playersList });
        console.log(`🔄 Sender rom-oppdatering etter at en spiller forlot.`);
    } else {
        console.log(`🗑️ Sletter tomt rom: ${roomId}`);
        delete rooms[roomId];
    }
}

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
