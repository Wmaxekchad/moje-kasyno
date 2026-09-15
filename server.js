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

// ==========================================
// --- RULETKA ENGINE ---
// ==========================================
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

// ==========================================
// --- BLACKJACK ENGINE ---
// ==========================================
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

// ==========================================
// --- BUKMACHER ENGINE (5-MINUTOWY SYSTEM + RYNKI) ---
// ==========================================
const SPORTS_DB = {
    football: [
        { name: "Real Madryt", rating: 92 }, { name: "FC Barcelona", rating: 89 },
        { name: "Manchester City", rating: 94 }, { name: "Bayern Monachium", rating: 88 },
        { name: "Arsenal", rating: 87 }, { name: "PSG", rating: 86 },
        { name: "Inter Mediolan", rating: 84 }, { name: "BVB Dortmund", rating: 82 }
    ],
    basketball: [
        { name: "Boston Celtics", rating: 91 }, { name: "Denver Nuggets", rating: 89 },
        { name: "LA Lakers", rating: 85 }, { name: "Golden State Warriors", rating: 84 }
    ],
    cs2: [
        { name: "FaZe Clan", rating: 90 }, { name: "Natus Vincere", rating: 91 },
        { name: "G2 Esports", rating: 88 }, { name: "Vitality", rating: 89 }
    ],
    tennis: [
        { name: "Iga Świątek", rating: 95 }, { name: "Aryna Sabalenka", rating: 92 },
        { name: "Jannik Sinner", rating: 94 }, { name: "Carlos Alcaraz", rating: 93 }
    ]
};

let sportsTimer = 300; // 5 minut
let sportsMatches = [];

function calcProbabilities(r1, r2, isDrawAllowed = true) {
    const diff = r1 - r2;
    let prob1 = 1 / (1 + Math.pow(10, -diff / 400));
    let prob2 = 1 - prob1;
    let probX = 0;

    if (isDrawAllowed) {
        probX = 0.26;
        prob1 *= (1 - probX);
        prob2 *= (1 - probX);
    }
    return { prob1, probX, prob2 };
}

function probToOdds(prob, margin = 0.06) {
    if (!prob || prob <= 0) return null;
    return parseFloat((1 / (prob * (1 + margin))).toFixed(2));
}

function generate5MinMatches() {
    sportsMatches = [];
    let idCounter = Date.now();

    // Piłka Nożna (3 mecze)
    const fb = [...SPORTS_DB.football].sort(() => 0.5 - Math.random());
    for (let i = 0; i < 3; i++) {
        const t1 = fb[i * 2], t2 = fb[i * 2 + 1];
        const probs = calcProbabilities(t1.rating, t2.rating, true);
        
        sportsMatches.push({
            id: idCounter++,
            sport: '⚽ Piłka Nożna',
            team1: t1.name, team2: t2.name,
            probs: probs,
            markets: {
                '1X2': { '1': probToOdds(probs.prob1), 'X': probToOdds(probs.probX), '2': probToOdds(probs.prob2) },
                'BTTS': { 'TAK': probToOdds(0.52), 'NIE': probToOdds(0.48) },
                'GOALS_2.5': { 'OVER': probToOdds(0.49), 'UNDER': probToOdds(0.51) }
            },
            status: 'OPEN', result: null
        });
    }

    // Koszykówka (1 mecz)
    const bb = [...SPORTS_DB.basketball].sort(() => 0.5 - Math.random());
    const bbProbs = calcProbabilities(bb[0].rating, bb[1].rating, false);
    sportsMatches.push({
        id: idCounter++,
        sport: '🏀 Koszykówka',
        team1: bb[0].name, team2: bb[1].name,
        probs: bbProbs,
        markets: {
            '12': { '1': probToOdds(bbProbs.prob1), '2': probToOdds(bbProbs.prob2) },
            'HANDI': { 'H1 (-5.5)': probToOdds(bbProbs.prob1 * 0.85), 'H2 (+5.5)': probToOdds(bbProbs.prob2 * 1.15) }
        },
        status: 'OPEN', result: null
    });

    // CS2 (1 mecz)
    const cs = [...SPORTS_DB.cs2].sort(() => 0.5 - Math.random());
    const csProbs = calcProbabilities(cs[0].rating, cs[1].rating, false);
    sportsMatches.push({
        id: idCounter++,
        sport: '🎮 CS2',
        team1: cs[0].name, team2: cs[1].name,
        probs: csProbs,
        markets: {
            '12': { '1': probToOdds(csProbs.prob1), '2': probToOdds(csProbs.prob2) },
            'MAPS_2.5': { 'OVER': probToOdds(0.35), 'UNDER': probToOdds(0.65) }
        },
        status: 'OPEN', result: null
    });

    // Tenis (1 mecz)
    const tn = [...SPORTS_DB.tennis].sort(() => 0.5 - Math.random());
    const tnProbs = calcProbabilities(tn[0].rating, tn[1].rating, false);
    sportsMatches.push({
        id: idCounter++,
        sport: '🎾 Tenis',
        team1: tn[0].name, team2: tn[1].name,
        probs: tnProbs,
        markets: {
            '12': { '1': probToOdds(tnProbs.prob1), '2': probToOdds(tnProbs.prob2) },
            'EXACT_SCORE': { 
                '2:0': probToOdds(tnProbs.prob1 * 0.6), 
                '2:1': probToOdds(tnProbs.prob1 * 0.4),
                '0:2': probToOdds(tnProbs.prob2 * 0.6),
                '1:2': probToOdds(tnProbs.prob2 * 0.4) 
            }
        },
        status: 'OPEN', result: null
    });

    io.emit('sports-matches-update', { matches: sportsMatches, timer: sportsTimer });
}

setInterval(() => {
    sportsTimer--;
    io.emit('sports-timer-tick', sportsTimer);

    if (sportsTimer <= 0) {
        resolveAllSportsMatches();
        sportsTimer = 300;
        generate5MinMatches();
    }
}, 1000);

function resolveAllSportsMatches() {
    sportsMatches.forEach(m => {
        m.status = 'RESOLVED';
        m.winningPicks = [];

        const rand = Math.random();
        let mainRes = '2';
        if (rand < m.probs.prob1) mainRes = '1';
        else if (rand < m.probs.prob1 + m.probs.probX) mainRes = 'X';
        
        m.winningPicks.push(mainRes);

        if (Math.random() > 0.45) m.winningPicks.push('TAK'); else m.winningPicks.push('NIE');
        if (Math.random() > 0.50) m.winningPicks.push('OVER'); else m.winningPicks.push('UNDER');
        if (mainRes === '1') { m.winningPicks.push('H1 (-5.5)'); m.winningPicks.push('2:0'); m.winningPicks.push('2:1'); } 
        else { m.winningPicks.push('H2 (+5.5)'); m.winningPicks.push('0:2'); m.winningPicks.push('1:2'); }
    });

    db.coupons.forEach(coupon => {
        if (coupon.status !== 'PENDING') return;

        let couponWon = true;

        for (let sel of coupon.selections) {
            const m = sportsMatches.find(x => x.id === sel.matchId);
            if (!m || !m.winningPicks.includes(sel.pick)) {
                couponWon = false;
                break;
            }
        }

        coupon.status = couponWon ? 'WON' : 'LOST';

        if (couponWon && db.players[coupon.nick]) {
            db.players[coupon.nick].balance += coupon.potentialWin;
            let socket = Array.from(io.sockets.sockets.values()).find(s => s.nick === coupon.nick);
            if (socket) {
                socket.emit('notification', { type: 'success', msg: `🎉 Kupon #${coupon.id} wygrał $${coupon.potentialWin.toLocaleString()}!` });
                socket.emit('balance-update', db.players[coupon.nick].balance);
            }
        }
    });

    saveDB();
    io.emit('coupons-update');
}

generate5MinMatches();

// ==========================================
// --- SOCKETS & HELPERY ---
// ==========================================
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
            selections: data.selections,
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NapletoCasino działa na http://localhost:${PORT}`));
