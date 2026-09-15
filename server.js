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
// Konta administratorów — logowanie odbywa się po nicku + haśle.
const ADMIN_USERS = {
    maceke: 'Naplet123#',
    wmaxek: 'Naplet123#'
};

app.use(express.static(path.join(__dirname, 'public')));

let db = { players: {}, coupons: [] };
if (fs.existsSync(DB_FILE)) {
    try { 
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        if (!db.coupons) db.coupons = [];
    } catch (e) { console.error("Błąd bazy:", e); }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function logEvent(text) {
    const entry = `[${new Date().toLocaleString('pl-PL')}] ${text}\n`;
    fs.appendFileSync(LOG_FILE, entry);
    io.emit('admin-log', entry);
}

// --- RULETKA (BEZ ZMIAN) ---
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

let rouletteState = {
    timer: 15,
    status: 'WAITING',
    forcedResult: null,
    history: [12, 35, 0, 7, 22, 18, 2, 29],
    bets: []
};

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
        rouletteState.bets.forEach(bet => {
            let socket = Array.from(io.sockets.sockets.values()).find(s => s.nick === bet.nick);
            if (!socket || !db.players[bet.nick]) return;

            let won = false;
            let multiplier = 0;

            if (bet.type === 'number' && parseInt(bet.value) === winningNumber) { won = true; multiplier = 36; }
            else if (bet.type === 'color' && bet.value === winningColor) { won = true; multiplier = 2; }
            else if (bet.type === 'even' && winningNumber !== 0 && winningNumber % 2 === 0) { won = true; multiplier = 2; }
            else if (bet.type === 'odd' && winningNumber % 2 !== 0) { won = true; multiplier = 2; }
            else if (bet.type === 'doz1' && winningNumber >= 1 && winningNumber <= 12) { won = true; multiplier = 3; }
            else if (bet.type === 'doz2' && winningNumber >= 13 && winningNumber <= 24) { won = true; multiplier = 3; }
            else if (bet.type === 'doz3' && winningNumber >= 25 && winningNumber <= 36) { won = true; multiplier = 3; }
            else if (bet.type === 'half1' && winningNumber >= 1 && winningNumber <= 18) { won = true; multiplier = 2; }
            else if (bet.type === 'half2' && winningNumber >= 19 && winningNumber <= 36) { won = true; multiplier = 2; }

            if (won) {
                let winAmount = bet.amount * multiplier;
                db.players[bet.nick].balance += winAmount;
                socket.emit('notification', { type: 'success', msg: `Wygrałeś $${winAmount.toLocaleString()} w ruletce!` });
                socket.emit('balance-update', db.players[bet.nick].balance);
            }
        });

        saveDB();
        rouletteState.history.unshift(winningNumber);
        if (rouletteState.history.length > 10) rouletteState.history.pop();

        rouletteState.bets = [];
        rouletteState.timer = 15;
        rouletteState.status = 'WAITING';

        io.emit('roulette-reset', {
            history: rouletteState.history,
            players: getOnlinePlayersData()
        });
    }, 6000);
}

// --- BLACKJACK ENGINE (BEZ ZMIAN) ---
const blackjackGames = {};

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) deck.push({ suit: s, value: v });
    }
    return deck.sort(() => Math.random() - 0.5);
}

function calculateHand(hand) {
    let score = 0, aces = 0;
    for (let card of hand) {
        if (['J', 'Q', 'K'].includes(card.value)) score += 10;
        else if (card.value === 'A') { score += 11; aces++; }
        else score += parseInt(card.value);
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

// --- BUKMACHER ENGINE (NOWOŚĆ) ---
let sportsMatches = [];
let nextSportsId = 1000;

const SPORTS_TEAMS = [
    ['⚽ Piłka Nożna', 'Real Madryt', 'FC Barcelona'],
    ['⚽ Piłka Nożna', 'Arsenal', 'Chelsea'],
    ['⚽ Piłka Nożna', 'Manchester City', 'Liverpool'],
    ['⚽ Piłka Nożna', 'Bayern Monachium', 'Borussia Dortmund'],
    ['⚽ Piłka Nożna', 'PSG', 'Olympique Marsylia'],
    ['⚽ Piłka Nożna', 'Inter Mediolan', 'AC Milan'],
    ['⚽ Piłka Nożna', 'Juventus', 'Napoli'],
    ['⚽ Piłka Nożna', 'Atletico Madryt', 'Sevilla'],
    ['🏀 Koszykówka', 'LA Lakers', 'Golden State Warriors'],
    ['🏀 Koszykówka', 'Boston Celtics', 'Miami Heat'],
    ['🏀 Koszykówka', 'Chicago Bulls', 'New York Knicks'],
    ['🏀 Koszykówka', 'Dallas Mavericks', 'Phoenix Suns'],
    ['🎮 CS2', 'Natus Vincere', 'FaZe Clan'],
    ['🎮 CS2', 'G2 Esports', 'Vitality'],
    ['🎮 CS2', 'Spirit', 'MOUZ'],
    ['🎮 CS2', 'Astralis', 'Ninjas in Pyjamas'],
    ['🎾 Tenis', 'Iga Świątek', 'Aryna Sabalenka'],
    ['🎾 Tenis', 'Carlos Alcaraz', 'Jannik Sinner'],
    ['🎾 Tenis', 'Coco Gauff', 'Jessica Pegula'],
    ['🎾 Tenis', 'Daniil Medvedev', 'Alexander Zverev']
];

function generateRandomMatch() {
    const template = SPORTS_TEAMS[Math.floor(Math.random() * SPORTS_TEAMS.length)];
    const id = nextSportsId++;
    const hasDraw = template[0].includes('Piłka Nożna') || template[0].includes('Koszykówka');

    const newMatch = {
        id,
        sport: template[0],
        team1: template[1],
        team2: template[2],
        odds: {
            '1': Number((Math.random() * 2 + 1.20).toFixed(2)),
            'X': hasDraw ? Number((Math.random() * 3 + 2.80).toFixed(2)) : null,
            '2': Number((Math.random() * 2 + 1.30).toFixed(2))
        },
        status: 'OPEN',
        result: null,
        createdAt: new Date().toISOString(),
        autoResolveAt: Date.now() + 300000
    };

    sportsMatches.push(newMatch);

    // Maksymalnie 100 widocznych opcji/meczów w systemie.
    if (sportsMatches.length > 100) {
        sportsMatches.splice(0, sportsMatches.length - 100);
    }

    io.emit('sports-matches-update', sportsMatches);

    // Każdy automatycznie wygenerowany mecz jest rozstrzygany dokładnie 5 minut później.
    setTimeout(() => {
        const match = sportsMatches.find(m => m.id === id);
        if (!match || match.status === 'RESOLVED') return;

        const possibleResults = match.odds['X'] ? ['1', 'X', '2'] : ['1', '2'];
        const result = possibleResults[Math.floor(Math.random() * possibleResults.length)];
        resolveMatch(id, result);
    }, 300000);

    return newMatch;
}

// Wypełnij bukmachera do 100 opcji przy starcie.
for (let i = 0; i < 100; i++) {
    generateRandomMatch();
}

// Od teraz dokładnie 3 nowe mecze/opcje co 5 minut.
setInterval(() => {
    generateRandomMatch();
    generateRandomMatch();
    generateRandomMatch();
}, 300000);

function resolveMatch(matchId, result) {
    const match = sportsMatches.find(m => m.id === parseInt(matchId));
    if (!match || match.status === 'RESOLVED') return;

    match.status = 'RESOLVED';
    match.result = result; // '1', 'X', lub '2'

    // Rozliczanie kuponów
    db.coupons.forEach(coupon => {
        if (coupon.status !== 'PENDING') return;

        let allResolved = true;
        let couponWon = true;

        for (let sel of coupon.selections) {
            const m = sportsMatches.find(x => x.id === sel.matchId);
            if (!m || m.status !== 'RESOLVED') {
                allResolved = false;
                break;
            }
            if (m.result !== sel.pick) {
                couponWon = false;
            }
        }

        if (allResolved) {
            coupon.status = couponWon ? 'WON' : 'LOST';
            if (couponWon) {
                if (db.players[coupon.nick]) {
                    db.players[coupon.nick].balance += coupon.potentialWin;
                    let socket = Array.from(io.sockets.sockets.values()).find(s => s.nick === coupon.nick);
                    if (socket) {
                        socket.emit('notification', { type: 'success', msg: `Twój kupon wygrał $${coupon.potentialWin.toLocaleString()}!` });
                        socket.emit('balance-update', db.players[coupon.nick].balance);
                    }
                }
            }
        }
    });

    saveDB();
    io.emit('sports-matches-update', sportsMatches);
    io.emit('coupons-update');
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
    socket.isAdmin = false;

    socket.on('set-nickname', (data) => {
        // Obsługujemy również stary format, gdyby frontend wysłał sam tekst.
        const requestedNick = typeof data === 'string' ? data : data.nick;
        const password = typeof data === 'string' ? '' : (data.password || '');
        const cleanNick = String(requestedNick || '').trim() || 'Gracz_' + Math.floor(Math.random() * 1000);

        // Nicki adminów są zarezerwowane i wymagają poprawnego hasła.
        if (Object.prototype.hasOwnProperty.call(ADMIN_USERS, cleanNick)) {
            if (ADMIN_USERS[cleanNick] !== password) {
                return socket.emit('admin-auth-failed', { msg: 'Nieprawidłowe hasło administratora.' });
            }
            socket.isAdmin = true;
            logEvent(`ADMIN zalogował się jako ${cleanNick}`);
        } else {
            socket.isAdmin = false;
        }

        socket.nick = cleanNick;

        if (!db.players[cleanNick]) {
            db.players[cleanNick] = { balance: 1000, createdAt: new Date() };
            saveDB();
            logEvent(`Nowy gracz: ${cleanNick} (Otrzymał $1 000)`);
        }

        socket.emit('init-player', {
            nick: cleanNick,
            balance: db.players[cleanNick].balance,
            isAdmin: socket.isAdmin,
            history: rouletteState.history,
            timer: rouletteState.timer,
            currentBets: rouletteState.bets,
            sportsMatches: sportsMatches,
            coupons: db.coupons.filter(c => c.nick === cleanNick)
        });

        io.emit('admin-players-update', getOnlinePlayersData());
    });

    // RULETKA HANDLERS
    socket.on('place-roulette-bet', (data) => {
        if (!socket.nick || rouletteState.status !== 'WAITING' || rouletteState.timer <= 2) return;
        
        const player = db.players[socket.nick];
        const amount = parseInt(data.amount);

        if (!amount || amount <= 0 || player.balance < amount) {
            return socket.emit('notification', { type: 'error', msg: 'Brak wystarczających środków!' });
        }

        if (data.type === 'color') {
            let hasColorBet = rouletteState.bets.some(b => b.nick === socket.nick && b.type === 'color');
            if (hasColorBet) {
                return socket.emit('notification', { type: 'error', msg: 'Obstawiłeś już kolor w tej rundzie!' });
            }
        }

        player.balance -= amount;
        saveDB();

        const newBet = { nick: socket.nick, type: data.type, value: data.value, amount: amount };
        rouletteState.bets.push(newBet);

        socket.emit('balance-update', player.balance);
        io.emit('new-live-bet', newBet);
        io.emit('admin-players-update', getOnlinePlayersData());
    });

    // BLACKJACK HANDLERS
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

        blackjackGames[socket.id] = { deck, playerHand, dealerHand, bet: betAmount, status: 'PLAYING' };

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
        let winStatus = '', payout = 0;

        if (dScore > 21 || pScore > dScore) { winStatus = 'WIN'; payout = game.bet * 2; }
        else if (pScore === dScore) { winStatus = 'DRAW'; payout = game.bet; }
        else { winStatus = 'LOSE'; }

        if (payout > 0) {
            db.players[socket.nick].balance += payout;
            saveDB();
            socket.emit('balance-update', db.players[socket.nick].balance);
        }

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

    // BUKMACHER HANDLERS
    socket.on('place-sports-coupon', (data) => {
        const player = db.players[socket.nick];
        const stake = parseInt(data.stake);

        if (!stake || stake <= 0 || player.balance < stake) {
            return socket.emit('notification', { type: 'error', msg: 'Brak środków na postawienie kuponu!' });
        }

        if (!data.selections || data.selections.length === 0) {
            return socket.emit('notification', { type: 'error', msg: 'Twój kupon jest pusty!' });
        }

        player.balance -= stake;
        saveDB();

        const coupon = {
            id: 'KUP-' + Math.floor(Math.random() * 899999 + 100000),
            nick: socket.nick,
            selections: data.selections, // [{ matchId, pick, odds, matchName }]
            stake: stake,
            totalOdds: data.totalOdds,
            potentialWin: Math.floor(stake * data.totalOdds),
            status: 'PENDING',
            createdAt: new Date().toLocaleTimeString()
        };

        db.coupons.push(coupon);
        saveDB();

        socket.emit('balance-update', player.balance);
        socket.emit('coupon-placed-success', coupon);
        socket.emit('notification', { type: 'success', msg: 'Kupon został pomyślnie postawiony!' });
    });

    // ADMIN HANDLERS
    socket.on('admin-set-balance', (data) => {
        if (!socket.isAdmin) return;
        if (db.players[data.nick]) {
            db.players[data.nick].balance = parseInt(data.balance);
            saveDB();
            io.emit('admin-players-update', getOnlinePlayersData());
        }
    });

    socket.on('admin-force-result', (num) => {
        if (!socket.isAdmin) return;
        rouletteState.forcedResult = parseInt(num);
        logEvent(`ADMIN ustawił wynik ruletki: ${num}`);
    });

    socket.on('admin-resolve-match', (data) => {
        if (!socket.isAdmin) return;
        resolveMatch(data.matchId, data.result);
        logEvent(`ADMIN rozstrzygnął mecz #${data.matchId} ze skutkiem: ${data.result}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NapletoCasino działa na http://localhost:${PORT}`));
