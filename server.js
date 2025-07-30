import SwiftUI
import Network
import AVFoundation

// MARK: - Models
struct Player: Codable, Identifiable {
    let id: String
    let name: String
    var isReady: Bool = false
}

// MARK: - LED Controller
class LEDController: ObservableObject {
    static let shared = LEDController()
    
    @Published var isFlashlightOn = false
    @Published var isScreenFlashing = false
    private var flashTimer: Timer?
    private var screenFlashTimer: Timer?
    
    private init() {}
    
    func toggleFlashlight() {
        isFlashlightOn.toggle()
        setFlashlight(isFlashlightOn)
    }
    
    func setFlashlight(_ isOn: Bool) {
        guard let device = AVCaptureDevice.default(for: .video),
              device.hasTorch else {
            print("Torch not available")
            return
        }
        
        do {
            try device.lockForConfiguration()
            device.torchMode = isOn ? .on : .off
            device.unlockForConfiguration()
            
            DispatchQueue.main.async {
                self.isFlashlightOn = isOn
            }
        } catch {
            print("Torch error: \(error)")
        }
    }
    
    func flashPattern(_ pattern: [Double]) {
        flashTimer?.invalidate()
        var index = 0
        
        flashTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
            if index >= pattern.count {
                timer.invalidate()
                self.setFlashlight(false)
                return
            }
            
            let duration = pattern[index]
            if index % 2 == 0 {
                self.setFlashlight(true)
            } else {
                self.setFlashlight(false)
            }
            
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                // Timer will handle the next step
            }
            
            index += 1
        }
    }
    
    func flashScreen(_ pattern: [Double]) {
        screenFlashTimer?.invalidate()
        var index = 0
        
        screenFlashTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
            if index >= pattern.count {
                timer.invalidate()
                DispatchQueue.main.async {
                    self.isScreenFlashing = false
                }
                return
            }
            
            let duration = pattern[index]
            DispatchQueue.main.async {
                if index % 2 == 0 {
                    self.isScreenFlashing = true
                } else {
                    self.isScreenFlashing = false
                }
            }
            
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                // Timer will handle the next step
            }
            
            index += 1
        }
    }
    
    func flashBoth(_ pattern: [Double]) {
        flashPattern(pattern)
        flashScreen(pattern)
    }
    
    func handleLEDCommand(_ action: String) {
        print("🔥 LEDController handling action: \(action)")
        
        switch action {
        case "on":
            print("💡 Setting flashlight ON")
            setFlashlight(true)
        case "off":
            print("💡 Setting flashlight OFF")
            setFlashlight(false)
        case "flash":
            print("⚡ Flashing LED pattern")
            flashPattern([0.2, 0.2, 0.2, 0.2])
        case "screen_flash":
            print("📱 Flashing screen pattern")
            flashScreen([0.2, 0.2, 0.2, 0.2])
        case "both_flash":
            print("🔥 Flashing both LED and screen")
            flashBoth([0.2, 0.2, 0.2, 0.2])
        case "spinner_highlight":
            print("🎯 Spinner highlight - strong flash")
            flashBoth([0.15, 0.05, 0.15, 0.05])
        case "spinner_tick":
            print("🎰 Spinner tick - subtle screen flash")
            flashScreen([0.1, 0.05])
        default:
            print("❓ Unknown LED action: \(action)")
        }
    }
}

// MARK: - WebSocket Manager
class WebSocketManager: ObservableObject {
    @Published var isConnected = false
    @Published var players: [Player] = []
    @Published var gameMessage: String = ""
    @Published var currentPlayerId: String = ""
    @Published var currentRoomId: String = ""
    @Published var isSpinnerActive = false
    @Published var highlightedPlayerId: String = ""
    @Published var playerOrder: [String] = []
    
    private var webSocketTask: URLSessionWebSocketTask?
    private let serverURL = URL(string: "wss://drikkelek-server.onrender.com")!
    private let urlSession = URLSession(configuration: .default)
    
    func connect() {
        webSocketTask = urlSession.webSocketTask(with: serverURL)
        webSocketTask?.resume()
        
        receiveMessage()
        
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            self.isConnected = true
            print("✅ Connection status set to connected")
        }
    }
    
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        isConnected = false
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self?.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self?.receiveMessage()
                
            case .failure(let error):
                print("WebSocket error: \(error)")
                DispatchQueue.main.async {
                    self?.isConnected = false
                }
            }
        }
    }
    
    private func handleMessage(_ text: String) {
        print("📨 Received message: \(text)")
        
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messageType = json["type"] as? String else {
            print("❌ Failed to parse JSON")
            return
        }
        
        DispatchQueue.main.async {
            switch messageType {
            case "connected":
                print("✅ Connected to server")
                if let clientId = json["clientId"] as? String {
                    self.currentPlayerId = clientId
                    print("📱 Our client ID: \(clientId)")
                }
                
            case "room_joined":
                print("🏠 Successfully joined room")
                if let roomId = json["roomId"] as? String {
                    self.currentRoomId = roomId
                    print("🏠 Joined room: \(roomId)")
                }
                
            case "room_update":
                print("🔄 Room update received - processing players")
                self.handleRoomUpdate(json)
                
            case "led_command":
                print("💡 LED Command received")
                self.handleLEDCommand(json)
                
            case "led_control_sent":
                print("✅ LED control confirmation")
                if let message = json["message"] as? String {
                    self.gameMessage = message
                }
                
            case "error":
                print("❌ Server error")
                if let message = json["message"] as? String {
                    self.gameMessage = "Feil: \(message)"
                }
                
            case "left_room":
                print("👋 Left room confirmation")
                self.currentRoomId = ""
                self.players = []
                if let message = json["message"] as? String {
                    self.gameMessage = message
                }
                
            case "game_reset":
                print("🔄 Game reset notification")
                if let resetBy = json["resetBy"] as? String,
                   let message = json["message"] as? String {
                    self.gameMessage = "🔄 \(message)"
                    print("Game reset by: \(resetBy)")
                }
                
            case "spinner_start":
                print("🎰 Spinner started")
                self.isSpinnerActive = true
                if let playerOrder = json["playerOrder"] as? [String] {
                    self.playerOrder = playerOrder
                }
                
            case "spinner_highlight":
                print("🎯 Spinner highlight")
                if let playerId = json["highlightedPlayerId"] as? String {
                    self.highlightedPlayerId = playerId
                    
                    // Execute LED command if provided
                    if let ledAction = json["ledAction"] as? String {
                        print("💡 Executing LED action from spinner: \(ledAction)")
                        LEDController.shared.handleLEDCommand(ledAction)
                    }
                }
                
            case "spinner_result":
                print("🏆 Spinner result")
                self.isSpinnerActive = false
                self.highlightedPlayerId = ""
                if let winnerName = json["winnerName"] as? String,
                   let message = json["message"] as? String {
                    self.gameMessage = message
                }
                
            case "player_order_update":
                print("📋 Player order updated")
                if let playerOrder = json["playerOrder"] as? [String] {
                    self.playerOrder = playerOrder
                }
                
            case "spinner_error":
                print("❌ Spinner error")
                if let message = json["message"] as? String {
                    self.gameMessage = message
                }
                
            case "pong":
                print("🏓 Pong received")
                
            default:
                print("❓ Unknown message type: \(messageType)")
            }
        }
    }
    
    private func handleRoomUpdate(_ json: [String: Any]) {
        print("🔄 Processing room update...")
        
        guard let playersArray = json["players"] as? [[String: Any]] else {
            print("❌ No players array in room update")
            return
        }
        
        print("👥 Found \(playersArray.count) players in room update")
        
        var newPlayers: [Player] = []
        for playerData in playersArray {
            if let id = playerData["id"] as? String,
               let name = playerData["name"] as? String {
                let player = Player(id: id, name: name, isReady: true)
                newPlayers.append(player)
                print("✅ Added player: \(name) (\(id))")
            }
        }
        
        self.players = newPlayers
        print("🎯 Final players list: \(newPlayers.map { $0.name })")
    }
    
    private func handleLEDCommand(_ json: [String: Any]) {
        print("💡 Processing LED command: \(json)")
        
        guard let action = json["action"] as? String else {
            print("❌ No action in LED command")
            return
        }
        
        let from = json["fromName"] as? String ?? json["from"] as? String ?? "unknown"
        print("💡 LED command '\(action)' from \(from)")
        
        // Execute LED command immediately
        LEDController.shared.handleLEDCommand(action)
        print("✅ LED command executed: \(action)")
    }
    
    func joinRoom(_ roomId: String, playerName: String) {
        currentRoomId = roomId
        
        let message = [
            "type": "join_room",
            "roomId": roomId,
            "playerName": playerName
        ] as [String : Any]
        
        sendRawMessage(message)
        print("🔗 Joining room \(roomId) as \(playerName)")
    }
    
    func sendLEDCommand(to targetClientId: String, action: String) {
        let message = [
            "type": "control_led",
            "targetClientId": targetClientId,
            "action": action
        ] as [String : Any]
        
        sendRawMessage(message)
        print("💡 Sending LED command: \(action) to \(targetClientId)")
    }
    
    func sendLEDCommandToAll(action: String) {
        let message = [
            "type": "control_led",
            "targetClientId": "all",
            "action": action
        ] as [String : Any]
        
        sendRawMessage(message)
        print("💡 Sending LED command: \(action) to all players")
    }
    
    func leaveRoom() {
        if !currentRoomId.isEmpty {
            let message = [
                "type": "leave_room",
                "roomId": currentRoomId
            ] as [String : Any]
            
            sendRawMessage(message)
            print("👋 Leaving room \(currentRoomId)")
            
            currentRoomId = ""
            players = []
        }
    }
    
    func resetGame() {
        if !currentRoomId.isEmpty {
            let message = [
                "type": "reset_game",
                "roomId": currentRoomId
            ] as [String : Any]
            
            sendRawMessage(message)
            print("🔄 Requesting game reset")
        }
    }
    
    func startSpinner() {
        if !currentRoomId.isEmpty {
            let message = [
                "type": "start_spinner",
                "roomId": currentRoomId
            ] as [String : Any]
            
            sendRawMessage(message)
            print("🎰 Starting spinner")
        }
    }
    
    func setPlayerOrder(_ order: [String]) {
        if !currentRoomId.isEmpty {
            let message = [
                "type": "set_player_order",
                "roomId": currentRoomId,
                "playerOrder": order
            ] as [String : Any]
            
            sendRawMessage(message)
            print("📋 Setting player order: \(order)")
        }
    }
    
    private func sendRawMessage(_ messageDict: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: messageDict),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            print("❌ Failed to create JSON")
            return
        }
        
        print("📤 Sending: \(jsonString)")
        webSocketTask?.send(.string(jsonString)) { error in
            if let error = error {
                print("❌ Send error: \(error)")
            } else {
                print("✅ Message sent successfully")
            }
        }
    }
}

// MARK: - Main Views
struct ContentView: View {
    @StateObject private var webSocketManager = WebSocketManager()
    @StateObject private var ledController = LEDController.shared
    
    @State private var playerName = ""
    @State private var showingGame = false
    
    var body: some View {
        NavigationView {
            VStack(spacing: 30) {
                VStack {
                    Text("🍻 Drikkelek")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    
                    Text("LED Party Game")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                
                HStack {
                    Circle()
                        .fill(webSocketManager.isConnected ? Color.green : Color.red)
                        .frame(width: 12, height: 12)
                    
                    Text(webSocketManager.isConnected ? "Tilkoblet server" : "Ikke tilkoblet")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                VStack(spacing: 20) {
                    TextField("Ditt navn", text: $playerName)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                        .font(.title3)
                    
                    Text("Alle spillere går automatisk inn i samme rom")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                VStack(spacing: 15) {
                    Button(action: {
                        if !webSocketManager.isConnected {
                            webSocketManager.connect()
                        } else {
                            webSocketManager.joinRoom("MAIN", playerName: playerName)
                            showingGame = true
                        }
                    }) {
                        Text(webSocketManager.isConnected ? "Bli med i spill" : "Koble til server")
                            .foregroundColor(.white)
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(Color.blue)
                            .cornerRadius(10)
                    }
                    .disabled(playerName.isEmpty)
                    
                    Button(action: {
                        ledController.toggleFlashlight()
                    }) {
                        HStack {
                            Image(systemName: ledController.isFlashlightOn ? "flashlight.on.fill" : "flashlight.off.fill")
                            Text(ledController.isFlashlightOn ? "Slå av LED" : "Test LED")
                        }
                        .foregroundColor(.white)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(ledController.isFlashlightOn ? Color.orange : Color.gray)
                        .cornerRadius(10)
                    }
                }
                
                Spacer()
                
                if !webSocketManager.gameMessage.isEmpty {
                    Text(webSocketManager.gameMessage)
                        .padding()
                        .background(Color.blue.opacity(0.1))
                        .cornerRadius(10)
                }
            }
            .padding()
            .navigationTitle("Drikkelek")
        }
        .sheet(isPresented: $showingGame) {
            GameView(webSocketManager: webSocketManager)
        }
        .onAppear {
            webSocketManager.connect()
        }
    }
}

struct GameView: View {
    @ObservedObject var webSocketManager: WebSocketManager
    @StateObject private var ledController = LEDController.shared
    @State private var showingPlayerOrder = false
    
    @Environment(\.presentationMode) var presentationMode
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                
                if ledController.isScreenFlashing {
                    Color.white
                        .ignoresSafeArea()
                        .animation(.easeInOut(duration: 0.1), value: ledController.isScreenFlashing)
                }
                
                ScrollView {
                    VStack(spacing: 20) {
                        VStack {
                            Text("🎮 Spill i gang!")
                                .font(.title2)
                                .fontWeight(.bold)
                                .foregroundColor(ledController.isScreenFlashing ? .black : .white)
                            
                            if !webSocketManager.currentRoomId.isEmpty {
                                Text("Rom: \(webSocketManager.currentRoomId)")
                                    .font(.caption)
                                    .foregroundColor(ledController.isScreenFlashing ? .black : .secondary)
                            }
                        }
                        
                        // Spinner Section
                        VStack(spacing: 15) {
                            Text("🎯 Tilfeldig velger")
                                .font(.headline)
                                .foregroundColor(ledController.isScreenFlashing ? .black : .white)
                            
                            if webSocketManager.isSpinnerActive {
                                VStack {
                                    Text("🎰 Spinner kjører...")
                                        .font(.subheadline)
                                        .foregroundColor(.orange)
                                    
                                    ProgressView()
                                        .progressViewStyle(CircularProgressViewStyle(tint: .orange))
                                }
                            } else {
                                HStack(spacing: 10) {
                                    Button("🎰 Spin!") {
                                        webSocketManager.startSpinner()
                                    }
                                    .buttonStyle(SpinnerButtonStyle(color: .purple))
                                    .disabled(webSocketManager.players.count < 2)
                                    
                                    Button("📋") {
                                        showingPlayerOrder = true
                                    }
                                    .buttonStyle(SpinnerButtonStyle(color: .gray))
                                }
                                
                                if webSocketManager.players.count < 2 {
                                    Text("Trenger minst 2 spillere")
                                        .font(.caption)
                                        .foregroundColor(.orange)
                                }
                            }
                        }
                        
                        Divider().background(ledController.isScreenFlashing ? Color.black : Color.white)
                        
                        // LED Controls
                        VStack(spacing: 15) {
                            Text("Kontroller alle:")
                                .font(.headline)
                                .foregroundColor(ledController.isScreenFlashing ? .black : .white)
                            
                            HStack(spacing: 10) {
                                Button("💡 På") {
                                    webSocketManager.sendLEDCommandToAll(action: "on")
                                    ledController.setFlashlight(true)
                                }
                                .buttonStyle(SpinnerButtonStyle(color: .green))
                                
                                Button("💡 Av") {
                                    webSocketManager.sendLEDCommandToAll(action: "off")
                                    ledController.setFlashlight(false)
                                }
                                .buttonStyle(SpinnerButtonStyle(color: .red))
                            }
                            
                            HStack(spacing: 10) {
                                Button("⚡ LED") {
                                    webSocketManager.sendLEDCommandToAll(action: "flash")
                                    ledController.flashPattern([0.2, 0.2, 0.2, 0.2])
                                }
                                .buttonStyle(SpinnerButtonStyle(color: .orange))
                                
                                Button("📱 Skjerm") {
                                    webSocketManager.sendLEDCommandToAll(action: "screen_flash")
                                    ledController.flashScreen([0.2, 0.2, 0.2, 0.2])
                                }
                                .buttonStyle(SpinnerButtonStyle(color: .blue))
                            }
                            
                            Button("🔥 Alt!") {
                                webSocketManager.sendLEDCommandToAll(action: "both_flash")
                                ledController.flashBoth([0.2, 0.2, 0.2, 0.2])
                            }
                            .buttonStyle(SpinnerButtonStyle(color: .purple))
                            
                            // Test button for spinner effects
                            Button("🧪 Test Spinner") {
                                print("🧪 Testing spinner LED effects locally")
                                ledController.handleLEDCommand("spinner_highlight")
                                
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                    ledController.handleLEDCommand("spinner_tick")
                                }
                            }
                            .buttonStyle(SpinnerButtonStyle(color: .pink))
                        }
                        
                        Divider().background(ledController.isScreenFlashing ? Color.black : Color.white)
                        
                        // Players List
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Spillere (\(webSocketManager.players.count)):")
                                .font(.headline)
                                .foregroundColor(ledController.isScreenFlashing ? .black : .white)
                            
                            if webSocketManager.players.isEmpty {
                                Text("Kun du er i rommet...")
                                    .font(.caption)
                                    .foregroundColor(ledController.isScreenFlashing ? .black : .secondary)
                                    .padding()
                            } else {
                                ForEach(webSocketManager.players) { player in
                                    VStack(spacing: 8) {
                                        HStack {
                                            Circle()
                                                .fill(getPlayerColor(for: player))
                                                .frame(width: 12, height: 12)
                                            
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(player.name)
                                                    .font(.body)
                                                    .fontWeight(player.id == webSocketManager.currentPlayerId ? .bold : .regular)
                                                    .foregroundColor(ledController.isScreenFlashing ? .black : .white)
                                                
                                                Text(player.id == webSocketManager.currentPlayerId ? "Dette er deg" : "Kan kontrollere")
                                                    .font(.caption)
                                                    .foregroundColor(ledController.isScreenFlashing ? .black : .secondary)
                                            }
                                            
                                            Spacer()
                                        }
                                        
                                        if player.id != webSocketManager.currentPlayerId {
                                            HStack(spacing: 8) {
                                                Button("💡") {
                                                    webSocketManager.sendLEDCommand(to: player.id, action: "on")
                                                }
                                                .buttonStyle(SmallButtonStyle(color: .green))
                                                
                                                Button("❌") {
                                                    webSocketManager.sendLEDCommand(to: player.id, action: "off")
                                                }
                                                .buttonStyle(SmallButtonStyle(color: .red))
                                                
                                                Button("⚡") {
                                                    webSocketManager.sendLEDCommand(to: player.id, action: "flash")
                                                }
                                                .buttonStyle(SmallButtonStyle(color: .orange))
                                                
                                                Button("📱") {
                                                    webSocketManager.sendLEDCommand(to: player.id, action: "screen_flash")
                                                }
                                                .buttonStyle(SmallButtonStyle(color: .blue))
                                            }
                                        }
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 10)
                                    .background(getPlayerBackground(for: player))
                                    .cornerRadius(8)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 8)
                                            .stroke(
                                                webSocketManager.highlightedPlayerId == player.id ? Color.yellow : Color.clear,
                                                lineWidth: 3
                                            )
                                            .animation(.easeInOut(duration: 0.2), value: webSocketManager.highlightedPlayerId)
                                    )
                                }
                            }
                        }
                        
                        Spacer(minLength: 50)
                    }
                    .padding()
                }
            }
            .navigationTitle("Drikkelek")
            .navigationBarItems(
                leading: Button("🔄") {
                    webSocketManager.resetGame()
                },
                trailing: Button("Lukk") {
                    webSocketManager.leaveRoom()
                    presentationMode.wrappedValue.dismiss()
                }
            )
        }
        .sheet(isPresented: $showingPlayerOrder) {
            PlayerOrderView(webSocketManager: webSocketManager)
        }
    }
    
    private func getPlayerColor(for player: Player) -> Color {
        if webSocketManager.highlightedPlayerId == player.id {
            return .yellow
        } else if player.id == webSocketManager.currentPlayerId {
            return .blue
        } else {
            return .green
        }
    }
    
    private func getPlayerBackground(for player: Player) -> Color {
        if webSocketManager.highlightedPlayerId == player.id {
            return Color.yellow.opacity(0.3)
        } else if player.id == webSocketManager.currentPlayerId {
            return Color.blue.opacity(0.1)
        } else {
            return Color.gray.opacity(0.1)
        }
    }
}

struct PlayerOrderView: View {
    @ObservedObject var webSocketManager: WebSocketManager
    @Environment(\.presentationMode) var presentationMode
    
    @State private var orderedPlayers: [Player] = []
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                Text("🎯 Spinner rekkefølge")
                    .font(.title2)
                    .fontWeight(.bold)
                
                Text("Dra spillerne for å endre rekkefølgen")
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                List {
                    ForEach(orderedPlayers.indices, id: \.self) { index in
                        HStack {
                            Text("\(index + 1).")
                                .font(.headline)
                                .foregroundColor(.secondary)
                            
                            Circle()
                                .fill(orderedPlayers[index].id == webSocketManager.currentPlayerId ? Color.blue : Color.green)
                                .frame(width: 12, height: 12)
                            
                            Text(orderedPlayers[index].name)
                                .font(.body)
                            
                            Spacer()
                        }
                    }
                    .onMove(perform: movePlayer)
                }
                
                VStack(spacing: 15) {
                    Button("💾 Lagre rekkefølge") {
                        let playerOrder = orderedPlayers.map { $0.id }
                        webSocketManager.setPlayerOrder(playerOrder)
                        presentationMode.wrappedValue.dismiss()
                    }
                    .buttonStyle(SpinnerButtonStyle(color: .blue))
                    
                    Button("🔀 Tilfeldig") {
                        orderedPlayers.shuffle()
                    }
                    .buttonStyle(SpinnerButtonStyle(color: .orange))
                }
            }
            .padding()
            .navigationTitle("Rekkefølge")
            .navigationBarItems(trailing: Button("Lukk") {
                presentationMode.wrappedValue.dismiss()
            })
        }
        .onAppear {
            orderedPlayers = webSocketManager.players
        }
    }
    
    private func movePlayer(from source: IndexSet, to destination: Int) {
        orderedPlayers.move(fromOffsets: source, toOffset: destination)
    }
}

// MARK: - Button Styles
struct SpinnerButtonStyle: ButtonStyle {
    let color: Color
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(color)
            .cornerRadius(8)
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
    }
}

struct SmallButtonStyle: ButtonStyle {
    let color: Color
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(color.opacity(0.2))
            .cornerRadius(4)
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
    }
}

// MARK: - Preview
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
