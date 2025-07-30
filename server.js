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
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Drikkelek WebSocket Server is running!');
    }
});

// WebSocket server som bruker HTTP serveren
const wss = new WebSocket.Server({ server });

// Holder styr på alle tilkoblede klienter
const clients = new Map();
let clientIdCounter = 1;

console.log(`🚀 Drikkelek Server startet på port ${PORT}`);
console.log('📱 Venter på tilkoblinger...\n');

wss.on('connection', (ws) => {
    // Gi hver klient en unik ID
    const clientId = `client_${clientIdCounter++}`;
    clients.set(clientId, {
        ws: ws,
        id: clientId,
        connected: true
    });

    console.log(`✅ Ny klient tilkoblet: ${clientId}`);
    console.log(`📊 Totalt tilkoblede: ${clients.size}\n`);

    // Send velkommen-melding til ny klient
    ws.send(JSON.stringify({
        type: 'connected',
        clientId: clientId,
        message: `Du er tilkoblet som ${clientId}`
    }));

    // Send liste over alle tilkoblede klienter til alle
    broadcastClientList();

    // Håndter meldinger fra klienter
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Melding fra ${clientId}:`, message);

            switch (message.type) {
                case 'control_led':
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
        clients.delete(clientId);
        console.log(`📊 Totalt tilkoblede: ${clients.size}\n`);
        
        // Oppdater klientliste for alle andre
        broadcastClientList();
    });

    // Håndter feil
    ws.on('error', (error) => {
        console.error(`💥 WebSocket feil for ${clientId}:`, error);
        clients.delete(clientId);
        broadcastClientList();
    });
});

// Funksjon for å kontrollere LED på en annen klient
function handleLedControl(senderId, message) {
    const { targetClientId, action } = message;
    
    console.log(`💡 LED kontroll: ${senderId} vil ${action} LED på ${targetClientId}`);
    
    // Finn målklienten
    const targetClient = clients.get(targetClientId);
    
    if (!targetClient) {
        // Send feilmelding tilbake til sender
        const senderClient = clients.get(senderId);
        if (senderClient) {
            senderClient.ws.send(JSON.stringify({
                type: 'error',
                message: `Klient ${targetClientId} ikke funnet`
            }));
        }
        return;
    }

    // Send LED-kommando til målklienten
    targetClient.ws.send(JSON.stringify({
        type: 'led_command',
        action: action, // 'on' eller 'off'
        from: senderId,
        timestamp: Date.now()
    }));

    // Bekreft til sender at kommandoen ble sendt
    const senderClient = clients.get(senderId);
    if (senderClient) {
        senderClient.ws.send(JSON.stringify({
            type: 'led_control_sent',
            targetClientId: targetClientId,
            action: action,
            message: `LED ${action} kommando sendt til ${targetClientId}`
        }));
    }

    console.log(`✅ LED kommando sendt: ${action} til ${targetClientId}\n`);
}

// Send liste over alle tilkoblede klienter til alle
function broadcastClientList() {
    const clientList = Array.from(clients.keys());
    
    const message = JSON.stringify({
        type: 'client_list',
        clients: clientList,
        count: clientList.length
    });

    // Send til alle tilkoblede klienter
    clients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    });
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

console.log('🔗 Server klar for tilkoblinger!');