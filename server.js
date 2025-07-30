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
        
        const client = clients.get(clientId);
        if (client && client.roomId) {
            removePlayerFromRoom(clientId, client.roomId);
        }
        
        clients.delete(clientId);
        console.log(`📊 Totalt tilkoblede: ${clients.size}\n`);
    });

    // Håndter feil
    ws.on('error', (error) => {
        console.error(`💥 WebSocket feil for ${clientId}:`, error);
        
        const client = clients.get(clientId);
        if (client && client.roomId) {
            removePlayerFromRoom(clientId, client.roomId);
        }
        
        clients.delete(clientId);
    });
});

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
        console.log(`👋 ${player.name} left room ${roomId}`);
        
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
    
    console.log(`📊 Status: ${activeClients.length} aktive klienter, ${activeRooms} aktive rom`);
    
    if (activeRooms > 0) {
        Object.entries(rooms).forEach(([roomId, room]) => {
            const playerNames = Object.values(room.players).map(p => p.name).join(', ');
            console.log(`  🏠 Rom ${roomId}: ${playerNames}`);
        });
    }
}, 30000);

console.log('🔗 Server v2.0 klar for tilkoblinger!');
