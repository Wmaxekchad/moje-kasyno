const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Tutaj wpisz swoje IP (Lokalne lub Publiczne), aby dostawać uprawnienia Admina
const ADMIN_IPS = [
    '127.0.0.1', 
    '::1', 
    '::ffff:127.0.0.1'
    // Przykład: '83.24.12.99'
];

app.use(express.static(path.join(__dirname, 'public')));

// Pokoje Ruletki Multiplayer
const rooms = {
    'Pokój Pokój Łatwy ($10-$100)': { players: {}, bets: [], timer: 15, interval: null },
    'Pokój VIP ($100-$1000)': { players: {}, bets: [], timer: 15, interval: null }
};

function startRoomTimer(roomName) {
    const room = rooms[roomName];
    if (room.interval) return;

    room.interval = setInterval(() => {
        room.timer--;
        io.to(roomName).emit('timer-tick', room.timer);

        if (room.timer <= 0) {
            // Losowanie liczby 0-36
            const winningNumber = Math.floor(Math.random() * 37);
            
            let color = 'green';
            if (winningNumber !== 0) {
                const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
                color = reds.includes(winningNumber) ? 'red' : 'black';
            }

            // Rozliczanie zakładów
            for (let socketId in room.players) {
                const player = room.players[socketId];
                let winnings = 0;

                room.bets.filter(b => b.socketId === socketId).forEach(bet => {
                    if (bet.type === color) {
                        winnings += bet.amount * 2;
                    } else if (bet.type === 'number' && parseInt(bet.value) === winningNumber) {
                        winnings += bet.amount * 36;
                    }
                });

                player.balance += winnings;
            }

            io.to(roomName).emit('roulette-result', {
                number: winningNumber,
                color: color,
                players: room.players
            });

            // Reset pokoju
            room.bets = [];
            room.timer = 15;
        }
    }, 1000);
}

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address.replace('::ffff:', '');
    const isAdmin = ADMIN_IPS.includes(clientIp) || clientIp === '127.0.0.1';

    let user = {
        id: socket.id,
        nick: 'Gość',
        balance: 1000,
        currentRoom: null,
        isAdmin: isAdmin
    };

    // Weryfikacja i ustawianie nicku
    socket.on('set-nickname', (nick) => {
        user.nick = nick || 'Gracz_' + Math.floor(Math.random() * 1000);
        socket.emit('init-player', user);
    });

    // Dołączanie do pokoju ruletki
    socket.on('join-room', (roomName) => {
        if (!rooms[roomName]) return;

        if (user.currentRoom) {
            socket.leave(user.currentRoom);
            delete rooms[user.currentRoom].players[socket.id];
        }

        user.currentRoom = roomName;
        socket.join(roomName);
        rooms[roomName].players[socket.id] = user;

        startRoomTimer(roomName);

        io.to(roomName).emit('room-update', {
            players: rooms[roomName].players,
            roomName: roomName
        });
    });

    // Stawianie zakładu
    socket.on('place-bet', (data) => {
        const room = rooms[user.currentRoom];
        if (!room) return;

        if (user.balance >= data.amount && room.timer > 3) {
            user.balance -= data.amount;
            room.bets.push({
                socketId: socket.id,
                nick: user.nick,
                type: data.type,
                value: data.value,
                amount: data.amount
            });

            io.to(user.currentRoom).emit('bet-placed', {
                nick: user.nick,
                type: data.type,
                value: data.value,
                amount: data.amount,
                newBalance: user.balance
            });
        }
    });

    // Panel Admina: Doładowanie żetonów
    socket.on('admin-add-balance', (data) => {
        if (!user.isAdmin) return;
        
        for (let r in rooms) {
            if (rooms[r].players[data.targetSocketId]) {
                rooms[r].players[data.targetSocketId].balance += parseInt(data.amount);
                io.to(data.targetSocketId).emit('balance-updated', rooms[r].players[data.targetSocketId].balance);
                io.to(r).emit('room-update', { players: rooms[r].players, roomName: r });
            }
        }
    });

    socket.on('disconnect', () => {
        if (user.currentRoom && rooms[user.currentRoom]) {
            delete rooms[user.currentRoom].players[socket.id];
            io.to(user.currentRoom).emit('room-update', {
                players: rooms[user.currentRoom].players,
                roomName: user.currentRoom
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serwer uruchomiony na porcie ${PORT}`));