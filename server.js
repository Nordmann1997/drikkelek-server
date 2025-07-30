const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const clients = new Map();
const rooms = {};
let clientIdCounter = 1;

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
        res.end('Drikkelek WebSocket Server v2.0 is running!');
    }
});

const wss = new WebSocket.Server({ server });

console.log(`🚀 Drikkelek Server v2.0 startet på port ${PORT}`);

wss.on('connection', (ws) => {
    const clientId = `client_${clientIdCounter++}`;
    
    const clientInfo = {
        ws: ws,
        id: clientId,
        playerName: null,
        roomId: null,
        connected: true,
        joinedAt: new Date()
    };
    
    clients.set(clientId, clientInfo);
    console.log(`✅ Ny klient tilkoblet: ${clientId}`);

    ws.send(JSON.stringify({
        type: 'connected',
        clientId: clientId,
        message: `Du er tilkoblet som ${clientId}`
    }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}:`, message);

            switch (message.type) {
                case 'join_room':
                    handleJoinRoom(clientId, message);
                    break;
                case 'control_led':
                    handleLedControl(clientId, message);
                    break;
                case 'leave_room':
                    handleLeaveRoom(clientId, message);
                    break;
                case 'reset_game':
                    handleResetGame(clientId, message);
                    break;
                case 'start_spinner':
                    handleStartSpinner(clientId, message);
                    break;
                case 'set_player_order':
                    handleSetPlayerOrder(clientId, message);
                    break;
                case 'update_winner_duration':
                    handleUpdateWinnerDuration(clientId, message);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                    break;
                default:
                    console.log(`❓ Ukjent meldingstype: ${message.type}`);
            }
        } catch (error) {
            console.error(`❌ Feil ved parsing av melding fra ${clientId}:`, error);
        }
    });

    ws.on('close', () => {
        console.log(`❌ Klient frakoblet: ${clientId}`);
        handleClientDisconnect(clientId);
    });

    ws.on('error', (error) => {
        console.error(`💥 WebSocket feil for ${clientId}:`, error);
        handleClientDisconnect(clientId);
    });
});

function handleClientDisconnect(clientId) {
    const client = clients.get(clientId);
    
    if (client) {
        if (client.roomId && rooms[client.roomId]) {
            removePlayerFromRoom(clientId, client.roomId);
        }
        clients.delete(clientId);
        console.log(`🧹 Cleaned up client ${clientId}`);
    }
}

function handleJoinRoom(clientId, message) {
    const { roomId, playerName } = message;
    
    if (!roomId || !playerName) {
        return;
    }
    
    const client = clients.get(clientId);
    if (!client) return;
    
    client.playerName = playerName;
    client.roomId = roomId;
    
    if (!rooms[roomId]) {
        rooms[roomId] = {
            id: roomId,
            players: {},
            createdAt: new Date(),
            winnerDuration: 5
        };
        console.log(`🏠 Created new room: ${roomId}`);
    }
    
    rooms[roomId].players[clientId] = {
        id: clientId,
        name: playerName,
        joinedAt: new Date()
    };
    
    console.log(`👤 ${playerName} (${clientId}) joined room ${roomId}`);
    
    client.ws.send(JSON.stringify({
        type: 'room_joined',
        roomId: roomId,
        playerName: playerName,
        message: `Du ble med i rom ${roomId} som ${playerName}`
    }));
    
    broadcastRoomUpdate(roomId);
}

function handleLeaveRoom(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) {
        return;
    }
    
    const roomId = client.roomId;
    removePlayerFromRoom(clientId, roomId);
    client.roomId = null;
    
    client.ws.send(JSON.stringify({
        type: 'left_room',
        roomId: roomId,
        message: `Du forlot rom ${roomId}`
    }));
    
    console.log(`👋 ${client.playerName || clientId} manually left room ${roomId}`);
}

function handleResetGame(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    console.log(`🔄 Game reset requested by ${client.playerName || clientId} in room ${roomId}`);
    
    const resetMessage = JSON.stringify({
        type: 'game_reset',
        roomId: roomId,
        resetBy: client.playerName || clientId,
        message: `Spillet ble nullstilt av ${client.playerName || clientId}`
    });
    
    Object.keys(room.players).forEach(playerId => {
        const playerClient = clients.get(playerId);
        if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
            playerClient.ws.send(resetMessage);
        }
    });
}

function handleStartSpinner(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) {
        client.ws.send(JSON.stringify({
            type: 'spinner_error',
            message: 'Trenger minst 2 spillere for å spinne'
        }));
        return;
    }
    
    console.log(`🎰 Spinner started by ${client.playerName || clientId} in room ${roomId}`);
    
    const playerOrder = room.playerOrder || playerIds;
    const totalSpins = 3 + Math.random() * 2;
    const totalSteps = Math.floor(totalSpins * playerOrder.length);
    const selectedIndex = Math.floor(Math.random() * playerOrder.length);
    const finalStep = totalSteps + selectedIndex;
    
    const winnerDuration = (message.winnerDuration || room.winnerDuration || 5) * 1000;
    
    console.log(`🎯 Spinner will land on ${room.players[playerOrder[selectedIndex]].name} after ${finalStep} steps`);
    
    const spinnerData = {
        type: 'spinner_start',
        roomId: roomId,
        playerOrder: playerOrder,
        totalSteps: finalStep,
        startedBy: client.playerName || clientId,
        winnerDuration: winnerDuration
    };
    
    Object.keys(room.players).forEach(playerId => {
        const playerClient = clients.get(playerId);
        if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
            playerClient.ws.send(JSON.stringify(spinnerData));
        }
    });
    
    startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration);
}

function handleSetPlayerOrder(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    const { playerOrder } = message;
    
    if (playerOrder && Array.isArray(playerOrder)) {
        const validOrder = playerOrder.filter(playerId => room.players[playerId]);
        
        if (validOrder.length === Object.keys(room.players).length) {
            room.playerOrder = validOrder;
            console.log(`📋 Player order set in room ${roomId}`);
            
            const orderUpdate = {
                type: 'player_order_update',
                roomId: roomId,
                playerOrder: validOrder,
                orderNames: validOrder.map(id => room.players[id].name)
            };
            
            Object.keys(room.players).forEach(playerId => {
                const playerClient = clients.get(playerId);
                if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
                    playerClient.ws.send(JSON.stringify(orderUpdate));
                }
            });
        }
    }
}

function handleUpdateWinnerDuration(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    const { winnerDuration } = message;
    
    if (typeof winnerDuration === 'number' && winnerDuration > 0) {
        room.winnerDuration = winnerDuration;
        
        console.log(`⏱️ Winner duration updated to ${winnerDuration}s in room ${roomId}`);
        
        const durationUpdate = {
            type: 'winner_duration_update',
            roomId: roomId,
            winnerDuration: winnerDuration,
            updatedBy: client.playerName || clientId
        };
        
        Object.keys(room.players).forEach(playerId => {
            if (playerId !== clientId) {
                const playerClient = clients.get(playerId);
                if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
                    playerClient.ws.send(JSON.stringify(durationUpdate));
                }
            }
        });
    }
}

function startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration) {
    const room = rooms[roomId];
    if (!room) return;
    
    let currentStep = 0;
    let currentPlayerIndex = 0;
    let interval = 100;
    const maxInterval = 800;
    
    function spinStep() {
        if (currentStep >= finalStep) {
            const winnerPlayerId = playerOrder[currentPlayerIndex];
            const winner = room.players[winnerPlayerId];
            
            console.log(`🏆 Spinner finished! Winner: ${winner.name}`);
            
            const winnerData = {
                type: 'spinner_result',
                roomId: roomId,
                winnerId: winnerPlayerId,
                winnerName: winner.name,
                message: `🎯 ${winner.name} ble valgt!`,
                winnerDuration: winnerDuration
            };
            
            Object.keys(room.players).forEach(playerId => {
                const playerClient = clients.get(playerId);
                if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
                    playerClient.ws.send(JSON.stringify(winnerData));
                }
            });
            
            const winnerClient = clients.get(winnerPlayerId);
            if (winnerClient && winnerClient.ws.readyState === WebSocket.OPEN) {
                winnerClient.ws.send(JSON.stringify({
                    type: 'led_command',
                    action: 'winner_highlight',
                    duration: winnerDuration,
                    from: 'spinner',
                    fromName: 'Spinner',
                    timestamp: Date.now()
                }));
            }
            
            return;
        }
        
        const currentPlayerId = playerOrder[currentPlayerIndex];
        
        Object.keys(room.players).forEach(playerId => {
            const playerClient = clients.get(playerId);
            if (playerClient && playerClient.ws.readyState === WebSocket.OPEN) {
                
                const highlightData = {
                    type: 'spinner_highlight',
                    roomId: roomId,
                    highlightedPlayerId: currentPlayerId,
                    step: currentStep,
                    totalSteps: finalStep
                };
                
                playerClient.ws.send(JSON.stringify(highlightData));
            }
        });
        
        currentStep++;
        currentPlayerIndex = (currentPlayerIndex + 1) % playerOrder.length;
        
        const progress = currentStep / finalStep;
        interval = Math.floor(100 + (maxInterval - 100) * Math.pow(progress, 2));
        
        setTimeout(spinStep, interval);
    }
    
    spinStep();
}

function handleLedControl(clientId, message) {
    const { targetClientId, targetId, action } = message;
    const target = targetClientId || targetId;
    
    console.log(`💡 LED kontroll: ${clientId} vil ${action} LED på ${target}`);
    
    const senderClient = clients.get(clientId);
    if (!senderClient) return;
    
    if (target === 'all') {
        if (senderClient.roomId && rooms[senderClient.roomId]) {
            const room = rooms[senderClient.roomId];
            
            Object.keys(room.players).forEach(playerId => {
                if (playerId !== clientId) {
                    const targetClient = clients.get(playerId);
                    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
                        targetClient.ws.send(JSON.stringify({
                            type: 'led_command',
                            action: action,
                            from: clientId,
                            fromName: senderClient.playerName || clientId,
                            timestamp: Date.now()
                        }));
                    }
                }
            });
        }
    } else {
        const targetClient = clients.get(target);
        
        if (!targetClient) {
            senderClient.ws.send(JSON.stringify({
                type: 'error',
                message: `Klient ${target} ikke funnet`
            }));
            return;
        }

        targetClient.ws.send(JSON.stringify({
            type: 'led_command',
            action: action,
            from: clientId,
            fromName: senderClient.playerName || clientId,
            timestamp: Date.now()
        }));

        senderClient.ws.send(JSON.stringify({
            type: 'led_control_sent',
            targetClientId: target,
            action: action,
            message: `LED ${action} kommando sendt til ${targetClient.playerName || target}`
        }));
    }
}

function broadcastRoomUpdate(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const playersList = Object.values(room.players).map(player => ({
        id: player.id,
        name: player.name,
        joinedAt: player.joinedAt
    }));
    
    const updateMessage = JSON.stringify({
        type: 'room_update',
        roomId: roomId,
        players: playersList,
        playerCount: playersList.length
    });
    
    Object.keys(room.players).forEach(playerId => {
        const client = clients.get(playerId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(updateMessage);
        }
    });
    
    console.log(`🔄 Room update sent to ${playersList.length} players in room ${roomId}`);
}

function removePlayerFromRoom(clientId, roomId) {
    if (!rooms[roomId]) return;
    
    const room = rooms[roomId];
    const player = room.players[clientId];
    
    if (player) {
        delete room.players[clientId];
        console.log(`👋 ${player.name} left room ${roomId}`);
        
        if (Object.keys(room.players).length === 0) {
            delete rooms[roomId];
            console.log(`🗑️ Deleted empty room ${roomId}`);
        } else {
            broadcastRoomUpdate(roomId);
        }
    }
}

server.listen(PORT, () => {
    console.log(`🌐 HTTP server tilgjengelig på port ${PORT}`);
    console.log(`🔌 WebSocket server tilgjengelig`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Server stenges ned...');
    clients.forEach((client) => {
        client.ws.close();
    });
    wss.close();
    server.close(() => {
        console.log('✅ Server stengt');
        process.exit(0);
    });
});

setInterval(() => {
    const activeClients = Array.from(clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN);
    const activeRooms = Object.keys(rooms).length;
    
    console.log(`📊 Status: ${activeClients.length} aktive klienter, ${activeRooms} aktive rom`);
    
    let cleanedUp = 0;
    clients.forEach((client, clientId) => {
        if (client.ws.readyState !== WebSocket.OPEN) {
            handleClientDisconnect(clientId);
            cleanedUp++;
        }
    });
    
    if (cleanedUp > 0) {
        console.log(`🧹 Cleaned up ${cleanedUp} stale connections`);
    }
}, 30000);

console.log('🔗 Server v2.0 klar for tilkoblinger!');
