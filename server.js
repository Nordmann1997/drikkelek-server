const WebSocket = require('ws');
const http = require('http');

// Bruk PORT fra environment (Render.com setter denne) eller 3000 lokalt
const PORT = process.env.PORT || 3000;

// Lag HTTP server først
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

// WebSocket server som bruker HTTP serveren
const wss = new WebSocket.Server({ server });

// Data structures
const clients = new Map(); // clientId -> client info
const rooms = {}; // roomId -> room info
let clientIdCounter = 1;

console.log(`🚀 Drikkelek Server v2.0 startet på port ${PORT}`);
console.log('📱 Venter på tilkoblinger...\n');

wss.on('connection', (ws) => {
    // Gi hver klient en unik ID
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
    console.log(`📊 Totalt tilkoblede: ${clients.size}\n`);

    // Send velkommen-melding til ny klient
    ws.send(JSON.stringify({
        type: 'connected',
        clientId: clientId,
        message: `Du er tilkoblet som ${clientId}`
    }));

    // Håndter meldinger fra klienter
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}:`, message);

            switch (message.type) {
                case 'join_room':
                    handleJoinRoom(clientId, message);
                    break;
                    
                case 'player_info':
                    handlePlayerInfo(clientId, message);
                    break;
                
                case 'control_led':
                    handleLedControl(clientId, message);
                    break;
                    
                case 'led_control':
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
                    
                case 'ping':
                    // Svar på ping for å teste tilkobling
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

    // Håndter frakobling
    ws.on('close', () => {
        console.log(`❌ Klient frakoblet: ${clientId}`);
        handleClientDisconnect(clientId);
    });

    // Håndter feil
    ws.on('error', (error) => {
        console.error(`💥 WebSocket feil for ${clientId}:`, error);
        handleClientDisconnect(clientId);
    });
});

// Handle client disconnect and cleanup
function handleClientDisconnect(clientId) {
    const client = clients.get(clientId);
    
    if (client) {
        // Remove from room if they were in one
        if (client.roomId && rooms[client.roomId]) {
            removePlayerFromRoom(clientId, client.roomId);
        }
        
        // Remove from clients map
        clients.delete(clientId);
        
        console.log(`🧹 Cleaned up client ${clientId}`);
        console.log(`📊 Totalt tilkoblede: ${clients.size}`);
        
        // Log current active clients
        if (clients.size > 0) {
            const activeClients = Array.from(clients.values())
                .filter(c => c.playerName)
                .map(c => `${c.playerName} (${c.id})`)
                .join(', ');
            console.log(`👥 Active players: ${activeClients}`);
        }
    }
}

// Handle player joining a room
function handleJoinRoom(clientId, message) {
    const { roomId, playerName } = message;
    
    if (!roomId || !playerName) {
        console.log(`❌ Missing roomId or playerName from ${clientId}`);
        return;
    }
    
    const client = clients.get(clientId);
    if (!client) return;
    
    // Update client info
    client.playerName = playerName;
    client.roomId = roomId;
    
    // Create room if it doesn't exist
    if (!rooms[roomId]) {
        rooms[roomId] = {
            id: roomId,
            players: {},
            createdAt: new Date()
        };
        console.log(`🏠 Created new room: ${roomId}`);
    }
    
    // Add player to room
    rooms[roomId].players[clientId] = {
        id: clientId,
        name: playerName,
        joinedAt: new Date()
    };
    
    console.log(`👤 ${playerName} (${clientId}) joined room ${roomId}`);
    
    // Send confirmation to player
    client.ws.send(JSON.stringify({
        type: 'room_joined',
        roomId: roomId,
        playerName: playerName,
        message: `Du ble med i rom ${roomId} som ${playerName}`
    }));
    
    // Broadcast updated room info to all players in room
    broadcastRoomUpdate(roomId);
}

// Handle player info updates
function handlePlayerInfo(clientId, message) {
    const { playerName } = message;
    
    const client = clients.get(clientId);
    if (!client) return;
    
    client.playerName = playerName;
    console.log(`📝 Updated player name for ${clientId}: ${playerName}`);
    
    // If player is in a room, update room info
    if (client.roomId && rooms[client.roomId]) {
        rooms[client.roomId].players[clientId] = {
            id: clientId,
            name: playerName,
            joinedAt: new Date()
        };
        
        broadcastRoomUpdate(client.roomId);
    }
}

// Handle player leaving room manually
function handleLeaveRoom(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) {
        console.log(`❌ Client ${clientId} not in any room`);
        return;
    }
    
    const roomId = client.roomId;
    removePlayerFromRoom(clientId, roomId);
    
    // Clear client room info but keep connection
    client.roomId = null;
    
    // Send confirmation
    client.ws.send(JSON.stringify({
        type: 'left_room',
        roomId: roomId,
        message: `Du forlot rom ${roomId}`
    }));
    
    console.log(`👋 ${client.playerName || clientId} manually left room ${roomId}`);
}

// Handle game reset
function handleResetGame(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    console.log(`🔄 Game reset requested by ${client.playerName || clientId} in room ${roomId}`);
    
    // Send reset notification to all players in room
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
    
    console.log(`✅ Game reset notification sent to all players in room ${roomId}`);
}

// Handle spinner (bottle spin equivalent)
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
    
    // Get player order or use default order
    const playerOrder = room.playerOrder || playerIds;
    
    // Calculate spinner animation
    const totalSpins = 3 + Math.random() * 2; // 3-5 full rotations
    const totalSteps = Math.floor(totalSpins * playerOrder.length);
    const selectedIndex = Math.floor(Math.random() * playerOrder.length);
    const finalStep = totalSteps + selectedIndex;
    
    // Get winner duration from message or default to 5 seconds
    const winnerDuration = (message.winnerDuration || 5) * 1000; // Convert to milliseconds
    
    console.log(`🎯 Spinner will land on ${room.players[playerOrder[selectedIndex]].name} after ${finalStep} steps`);
    console.log(`⏱️ Winner will be highlighted for ${winnerDuration/1000} seconds`);
    
    // Send spinner start to all players
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
    
    // Start the spinner animation
    startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration);
}

// Handle setting player order for spinner
function handleSetPlayerOrder(clientId, message) {
    const client = clients.get(clientId);
    if (!client || !client.roomId) return;
    
    const roomId = client.roomId;
    const room = rooms[roomId];
    if (!room) return;
    
    const { playerOrder } = message;
    
    if (playerOrder && Array.isArray(playerOrder)) {
        // Validate that all players in order exist in room
        const validOrder = playerOrder.filter(playerId => room.players[playerId]);
        
        if (validOrder.length === Object.keys(room.players).length) {
            room.playerOrder = validOrder;
            console.log(`📋 Player order set in room ${roomId}: ${validOrder.map(id => room.players[id].name).join(' → ')}`);
            
            // Broadcast new order to all players
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

// Animate the spinner
function startSpinnerAnimation(roomId, playerOrder, finalStep, winnerDuration) {
    const room = rooms[roomId];
    if (!room) return;
    
    let currentStep = 0;
    let currentPlayerIndex = 0;
    
    // Start fast, slow down gradually
    let interval = 100; // Start at 100ms
    const maxInterval = 800; // End at 800ms
    
    function spinStep() {
        if (currentStep >= finalStep) {
            // Spinner finished - announce winner with duration
            const winnerPlayerId = playerOrder[currentPlayerIndex];
            const winner = room.players[winnerPlayerId];
            
            console.log(`🏆 Spinner finished! Winner: ${winner.name} (${winnerPlayerId})`);
            console.log(`💡 Winner will be highlighted for ${winnerDuration/1000} seconds`);
            
            // Send winner announcement to all players
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
            
            // Send LED command to winner only
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
        
        // Current highlighted player
        const currentPlayerId = playerOrder[currentPlayerIndex];
        
        // Send highlight to all players (visual only, no LED)
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
        
        // Move to next player
        currentStep++;
        currentPlayerIndex = (currentPlayerIndex + 1) % playerOrder.length;
        
        // Slow down gradually
        const progress = currentStep / finalStep;
        interval = Math.floor(100 + (maxInterval - 100) * Math.pow(progress, 2));
        
        // Schedule next step
        setTimeout(spinStep, interval);
    }
    
    // Start the animation
    spinStep();
}

// Handle LED control
function handleLedControl(clientId, message) {
    const { targetClientId, targetId, action } = message;
    const target = targetClientId || targetId;
    
    console.log(`💡 LED kontroll: ${clientId} vil ${action} LED på ${target}`);
    
    const senderClient = clients.get(clientId);
    if (!senderClient) return;
    
    if (target === 'all') {
        // Send to all players in the same room
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
            
            console.log(`✅ LED kommando '${action}' sendt til alle i rom ${senderClient.roomId}`);
        }
    } else {
        // Send to specific target
        const targetClient = clients.get(target);
        
        if (!targetClient) {
            senderClient.ws.send(JSON.stringify({
                type: 'error',
                message: `Klient ${target} ikke funnet`
            }));
            return;
        }

        // Send LED command to target
        targetClient.ws.send(JSON.stringify({
            type: 'led_command',
            action: action,
            from: clientId,
            fromName: senderClient.playerName || clientId,
            timestamp: Date.now()
        }));

        // Confirm to sender
        senderClient.ws.send(JSON.stringify({
            type: 'led_control_sent',
            targetClientId: target,
            action: action,
            message: `LED ${action} kommando sendt til ${targetClient.playerName || target}`
        }));

        console.log(`✅ LED kommando '${action}' sendt fra ${senderClient.playerName || clientId} til ${targetClient.playerName || target}`);
    }
}

// Broadcast room update to all players in room
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
    
    // Send to all players in room
    Object.keys(room.players).forEach(playerId => {
        const client = clients.get(playerId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(updateMessage);
        }
    });
    
    console.log(`🔄 Room update sent to ${playersList.length} players in room ${roomId}`);
}

// Remove player from room
function removePlayerFromRoom(clientId, roomId) {
    if (!rooms[roomId]) return;
    
    const room = rooms[roomId];
    const player = room.players[clientId];
    
    if (player) {
        delete room.players[clientId];
        console.log(`👋 ${player.name} (${clientId}) left room ${roomId}`);
        
        // If room is empty, delete it
        if (Object.keys(room.players).length === 0) {
            delete rooms[roomId];
            console.log(`🗑️ Deleted empty room ${roomId}`);
        } else {
            // Broadcast update to remaining players
            broadcastRoomUpdate(roomId);
        }
    }
}

// Start HTTP server (som også håndterer WebSocket)
server.listen(PORT, () => {
    console.log(`🌐 HTTP server tilgjengelig på port ${PORT}`);
    console.log(`🔌 WebSocket server tilgjengelig på ws://localhost:${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Server stenges ned...');
    
    // Lukk alle WebSocket-tilkoblinger
    clients.forEach((client) => {
        client.ws.close();
    });
    
    // Lukk serverne
    wss.close();
    server.close(() => {
        console.log('✅ Server stengt');
        process.exit(0);
    });
});

// Status logging every 30 seconds
setInterval(() => {
    const activeClients = Array.from(clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN);
    const activeRooms = Object.keys(rooms).length;
    
    console.log(`\n📊 Status: ${activeClients.length} aktive klienter, ${activeRooms} aktive rom`);
    
    if (activeRooms > 0) {
        Object.entries(rooms).forEach(([roomId, room]) => {
            const playerNames = Object.values(room.players).map(p => p.name).join(', ');
            console.log(`  🏠 Rom ${roomId}: ${playerNames} (${Object.keys(room.players).length} spillere)`);
        });
    } else {
        console.log(`  📭 Ingen aktive rom`);
    }
    
    // Clean up any stale connections
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
