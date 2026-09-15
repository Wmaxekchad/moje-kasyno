const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_FILE = path.join(__dirname, 'database.json');
const LOG_FILE = path.join(__dirname, 'casino.log');
const ADMIN_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

app.use(express.static(path.join(__dirname, 'public')));

let db = { players: {} };
if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { console.error("Błąd bazy:", e); }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logEvent(text) {
    const entry = `[${new Date().toLocaleString('pl-PL')}] ${text}\n`;
    fs.appendFileSync(LOG_FILE, entry);
    io.emit('admin-log', entry);
}

// STRUKTURA RULETKI EUROPEJSKIEJ (0 - 36)
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

let rouletteState = {
    timer: 15,
    status: 'WAITING',
    forcedResult: null,
    history: [12, 35, 0, 7, 22, 18, 2, 29],
    bets: {} // idSocket: { betsArray: [] }
};

// Pętla Ruletki
setInterval(() => {
    if (rouletteState.status === 'WAITING') {
        rouletteState.timer--;
        io.emit('timer-tick', rouletteState.timer);
        if (rouletteState.timer <= 0) spinRoulette();
    }
}, 1000);

function spinRoulette() {
    rouletteState.status = 'SPINNING';
    
    let winningNumber;
    if (rouletteState.forcedResult !== null) {
        winningNumber = rouletteState.forcedResult;
        rouletteState.forcedResult = null;
    } else {
        winningNumber = Math.floor(Math.random() * 37);
    }

    let winningColor = winningNumber === 0 ? 'green' : (RED_NUMBERS.includes(winningNumber) ? 'red' : 'black');
    logEvent(`Ruletka: Wygrana cyfra ${winningNumber} (${winningColor.toUpperCase()})`);

    io.emit('roulette-spin', { winningNumber, winningColor });

    setTimeout(() => {
        // Rozliczenie zakładów
        for (let socketId in rouletteState.bets) {
            let pBets = rouletteState.bets[socketId];
            let socket = io.sockets.sockets.get(socketId);
            if (!socket || !socket.nick || !db.players[socket.nick]) continue;

            let totalWin = 0;
            pBets.forEach(bet => {
                let won = false;
                let multiplier = 0;

                if (bet.type === 'number' && parseInt(bet.value) === winningNumber) {
                    won = true; multiplier = 36;
                } else if (bet.type === 'color' && bet.value === winningColor) {
                    won = true; multiplier = 2;
                } else if (bet.type === 'even' && winningNumber !== 0 && winningNumber % 2 === 0) {
                    won = true; multiplier = 2;
                } else if (bet.type === 'odd' && winningNumber % 2 !== 0) {
                    won = true; multiplier = 2;
                } else if (bet.type === 'doz1' && winningNumber >= 1 && winningNumber <= 12) {
                    won = true; multiplier = 3;
                } else if (bet.type === 'doz2' && winningNumber >= 13 && winningNumber <= 24) {
                    won = true; multiplier = 3;
                } else if (bet.type === 'doz3' && winningNumber >= 25 && winningNumber <= 36) {
                    won = true; multiplier = 3;
                } else if (bet.type === 'half1' && winningNumber >= 1 && winningNumber <= 18) {
                    won = true; multiplier = 2;
                } else if (bet.type === 'half2' && winningNumber >= 19 && winningNumber <= 36) {
                    won = true; multiplier = 2;
                }

                if (won) totalWin += bet.amount * multiplier;
            });

            if (totalWin > 0) {
                db.players[socket.nick].balance += totalWin;
                socket.emit('notification', { type: 'success', msg: `Wygrałeś $${totalWin.toLocaleString()} w ruletce!` });
                logEvent(`Gracz ${socket.nick} wygrał $${totalWin} w ruletce.`);
            }
        }

        saveDB();
        rouletteState.history.unshift(winningNumber);
        if (rouletteState.history.length > 12) rouletteState.history.pop();

        rouletteState.bets = {};
        rouletteState.timer = 15;
        rouletteState.status = 'WAITING';

        io.emit('roulette-reset', {
            history: rouletteState.history,
            players: getOnlinePlayersData()
        });
    }, 6000);
}

// ENGINE BLACKJACKA
const blackjackGames = {};

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ suit: s, value: v });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function calculateHand(hand) {
    let score = 0;
    let aces = 0;
    for (let card of hand) {
        if (['J', 'Q', 'K'].includes(card.value)) score += 10;
        else if (card.value === 'A') { score += 11; aces++; }
        else score += parseInt(card.value);
    }
    while (score > 21 && aces > 0) {
        score -= 10;
        aces--;
    }
    return score;
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
            // STARTOWY BALANS = 1000$
            db.players[cleanNick] = { balance: 1000, createdAt: new Date() };
            saveDB();
            logEvent(`Nowy gracz: ${cleanNick} (Otrzymał $1 000)`);
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

    // ZAKŁADY RULETKI (Zasada 1 zakładu na ten sam typ)
    socket.on('place-roulette-bet', (data) => {
        if (!socket.nick || rouletteState.status !== 'WAITING' || rouletteState.timer <= 2) return;
        
        const player = db.players[socket.nick];
        const amount = parseInt(data.amount);

        if (!amount || amount <= 0 || player.balance < amount) {
            return socket.emit('notification', { type: 'error', msg: 'Brak wystarczających środków!' });
        }

        if (!rouletteState.bets[socket.id]) rouletteState.bets[socket.id] = [];
        let userBets = rouletteState.bets[socket.id];

        // Sprawdzenie limitu kolorów (Czerwony / Czarny)
        if (data.type === 'color') {
            let existingColorBet = userBets.find(b => b.type === 'color');
            if (existingColorBet) {
                return socket.emit('notification', { type: 'error', msg: 'Postawiłeś już zakład na kolor w tej rundzie!' });
            }
        }

        player.balance -= amount;
        saveDB();

        userBets.push({ type: data.type, value: data.value, amount });

        logEvent(`${socket.nick} obstawił $${amount} w ruletce na [${data.type}: ${data.value}]`);
        
        socket.emit('balance-update', player.balance);
        io.emit('admin-players-update', getOnlinePlayersData());
        socket.emit('notification', { type: 'info', msg: `Zakład przyjęty ($${amount})` });
    });

    // SILNIK BLACKJACKA
    socket.on('bj-start', (betAmount) => {
        const player = db.players[socket.nick];
        betAmount = parseInt(betAmount);

        if (!betAmount || betAmount <= 0 || player.balance < betAmount) {
            return socket.emit('notification', { type: 'error', msg: 'Brak środków na ten zakład!' });
        }

        player.balance -= betAmount;
        saveDB();

        const deck = createDeck();
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];

        blackjackGames[socket.id] = {
            deck, playerHand, dealerHand, bet: betAmount, status: 'PLAYING'
        };

        socket.emit('balance-update', player.balance);
        socket.emit('bj-state', {
            playerHand,
            dealerHand: [dealerHand[0], { suit: '?', value: '?' }],
            playerScore: calculateHand(playerHand),
            dealerScore: '?',
            status: 'PLAYING',
            bet: betAmount
        });
    });

    socket.on('bj-hit', () => {
        const game = blackjackGames[socket.id];
        if (!game || game.status !== 'PLAYING') return;

        game.playerHand.push(game.deck.pop());
        const pScore = calculateHand(game.playerHand);

        if (pScore > 21) {
            game.status = 'LOST';
            logEvent(`Blackjack: ${socket.nick} przegrał (Przekroczono 21)`);
            socket.emit('bj-state', {
                playerHand: game.playerHand,
                dealerHand: game.dealerHand,
                playerScore: pScore,
                dealerScore: calculateHand(game.dealerHand),
                status: 'BUST',
                bet: game.bet
            });
            delete blackjackGames[socket.id];
        } else {
            socket.emit('bj-state', {
                playerHand: game.playerHand,
                dealerHand: [game.dealerHand[0], { suit: '?', value: '?' }],
                playerScore: pScore,
                dealerScore: '?',
                status: 'PLAYING',
                bet: game.bet
            });
        }
    });

    socket.on('bj-stand', () => {
        const game = blackjackGames[socket.id];
        if (!game || game.status !== 'PLAYING') return;

        let dScore = calculateHand(game.dealerHand);
        while (dScore < 17) {
            game.dealerHand.push(game.deck.pop());
            dScore = calculateHand(game.dealerHand);
        }

        const pScore = calculateHand(game.playerHand);
        let winStatus = '';
        let payout = 0;

        if (dScore > 21 || pScore > dScore) {
            winStatus = 'WIN';
            payout = game.bet * 2;
        } else if (pScore === dScore) {
            winStatus = 'DRAW';
            payout = game.bet;
        } else {
            winStatus = 'LOSE';
        }

        if (payout > 0) {
            db.players[socket.nick].balance += payout;
            saveDB();
            socket.emit('balance-update', db.players[socket.nick].balance);
        }

        logEvent(`Blackjack: ${socket.nick} zakończył z wynikiem ${pScore} vs Dealer ${dScore} (${winStatus})`);

        socket.emit('bj-state', {
            playerHand: game.playerHand,
            dealerHand: game.dealerHand,
            playerScore: pScore,
            dealerScore: dScore,
            status: winStatus,
            bet: game.bet,
            payout
        });

        delete blackjackGames[socket.id];
    });

    // PANEL ADMINA
    socket.on('admin-set-balance', (data) => {
        if (!socket.isAdmin) return;
        if (db.players[data.nick]) {
            db.players[data.nick].balance = parseInt(data.balance);
            saveDB();
            logEvent(`ADMIN zmienił saldo gracza ${data.nick} na $${data.balance}`);
            io.emit('admin-players-update', getOnlinePlayersData());
        }
    });

    socket.on('admin-force-result', (num) => {
        if (!socket.isAdmin) return;
        rouletteState.forcedResult = parseInt(num);
        logEvent(`ADMIN ustawił wymuszony wynik ruletki: ${num}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serwer działa na http://localhost:${PORT}`));
