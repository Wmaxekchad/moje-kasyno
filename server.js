const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Plik bazy danych JSON i logów
const DB_FILE = path.join(__dirname, 'database.json');
const LOG_FILE = path.join(__dirname, 'casino.log');

// IP Administratora
const ADMIN_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

app.use(express.static(path.join(__dirname, 'public')));

// Baza danych graczy
let db = { players: {} };
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Błąd odczytu bazy:", e);
    }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logEvent(text) {
    const entry = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFileSync(LOG_FILE, entry);
    io.emit('admin-log', entry);
}

// Stan ruletki
let rouletteState = {
    timer: 15,
    timerMax: 15,
    status: 'WAITING', // 'WAITING', 'SPINNING'
    forcedResult: null, // Pozwala adminowi wymusić wynik
    history: [1, 12, 4, 0, 7, 14, 2, 11, 6], // Ostatnie wyniki
    bets: { red: [], green: [], black: [] }
};

// Pętla odliczania ruletki
setInterval(() => {
    if (rouletteState.status === 'WAITING') {
        rouletteState.timer--;
        io.emit('timer-tick', rouletteState.timer);

        if (rouletteState.timer <= 0) {
            spinRoulette();
        }
    }
}, 1000);

function spinRoulette() {
    rouletteState.status = 'SPINNING';
    
    // Losowanie (0 = zielony, 1-7 = czerwony, 8-14 = czarny)
    let winningNumber;
    if (rouletteState.forcedResult !== null) {
        winningNumber = rouletteState.forcedResult;
        rouletteState.forcedResult = null;
    } else {
        winningNumber = Math.floor(Math.random() * 15);
    }

    let winningColor = 'green';
    if (winningNumber >= 1 && winningNumber <= 7) winningColor = 'red';
    if (winningNumber >= 8 && winningNumber <= 14) winningColor = 'black';

    logEvent(`Losowanie: Wygrana cyfra ${winningNumber} (${winningColor.toUpperCase()})`);

    // Wysłanie komendy zakręcenia
    io.emit('roulette-spin', { winningNumber, winningColor });

    // Rozliczenie zakładów po zakończeniu animacji (po 5 sek)
    setTimeout(() => {
        let multiplier = winningColor === 'green' ? 7 : 2;
        let winnersLog = [];

        ['red', 'green', 'black'].forEach(color => {
            rouletteState.bets[color].forEach(bet => {
                if (color === winningColor) {
                    const winAmount = bet.amount * multiplier;
                    if (db.players[bet.nick]) {
                        db.players[bet.nick].balance += winAmount;
                    }
                    winnersLog.push(`${bet.nick} wygrał $${winAmount.toLocaleString()}`);
                }
            });
        });

        if (winnersLog.length > 0) {
            logEvent(`Wygrani: ${winnersLog.join(', ')}`);
        }

        saveDB();

        // Aktualizacja historii
        rouletteState.history.unshift(winningNumber);
        if (rouletteState.history.length > 10) rouletteState.history.pop();

        // Reset
        rouletteState.bets = { red: [], green: [], black: [] };
        rouletteState.timer = rouletteState.timerMax;
        rouletteState.status = 'WAITING';

        io.emit('roulette-reset', {
            history: rouletteState.history,
            players: getOnlinePlayersData()
        });
    }, 6000);
}

function getOnlinePlayersData() {
    const online = {};
    for (let [id, socket] of io.sockets.sockets) {
        if (socket.nick && db.players[socket.nick]) {
            online[id] = {
                nick: socket.nick,
                balance: db.players[socket.nick].balance,
                ip: socket.handshake.address.replace('::ffff:', ''),
                isAdmin: socket.isAdmin
            };
        }
    }
    return online;
}

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address.replace('::ffff:', '');
    socket.isAdmin = ADMIN_IPS.includes(clientIp) || clientIp === '127.0.0.1';

    socket.on('set-nickname', (nick) => {
        const cleanNick = nick.trim() || 'Gracz_' + Math.floor(Math.random() * 1000);
        socket.nick = cleanNick;

        if (!db.players[cleanNick]) {
            db.players[cleanNick] = { balance: 100000, createdAt: new Date() };
            saveDB();
            logEvent(`Nowy gracz po raz pierwszy: ${cleanNick}`);
        }

        socket.emit('init-player', {
            nick: cleanNick,
            balance: db.players[cleanNick].balance,
            isAdmin: socket.isAdmin,
            history: rouletteState.history,
            timer: rouletteState.timer
        });

        io.emit('admin-players-update', getOnlinePlayersData());
    });

    socket.on('place-bet', (data) => {
        if (!socket.nick || rouletteState.status !== 'WAITING' || rouletteState.timer <= 2) return;
        
        const player = db.players[socket.nick];
        const amount = parseInt(data.amount);

        if (amount > 0 && player && player.balance >= amount && ['red', 'green', 'black'].includes(data.color)) {
            player.balance -= amount;
            saveDB();

            rouletteState.bets[data.color].push({
                socketId: socket.id,
                nick: socket.nick,
                amount: amount
            });

            logEvent(`${socket.nick} postawił $${amount.toLocaleString()} na ${data.color}`);

            io.emit('bet-placed', {
                nick: socket.nick,
                color: data.color,
                amount: amount,
                bets: rouletteState.bets,
                playerBalance: player.balance
            });
        }
    });

    // PANEL ADMINA
    socket.on('admin-set-balance', (data) => {
        if (!socket.isAdmin) return;
        if (db.players[data.nick]) {
            db.players[data.nick].balance = parseInt(data.balance);
            saveDB();
            logEvent(`ADMIN zmienił saldo ${data.nick} na $${data.balance}`);
            io.emit('admin-players-update', getOnlinePlayersData());
            io.emit('balance-update', { nick: data.nick, balance: db.players[data.nick].balance });
        }
    });

    socket.on('admin-force-result', (number) => {
        if (!socket.isAdmin) return;
        rouletteState.forcedResult = parseInt(number);
        logEvent(`ADMIN wymusił następny wynik: ${number}`);
    });

    socket.on('admin-send-announcement', (msg) => {
        if (!socket.isAdmin) return;
        io.emit('announcement', msg);
    });

    socket.on('disconnect', () => {
        io.emit('admin-players-update', getOnlinePlayersData());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
