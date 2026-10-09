// src/socketHandler.js

// Simple in-memory storage for connected users
const users = new Map();

module.exports = function (io) {
  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Register user
    socket.on('register', (username) => {
      users.set(socket.id, username);
      io.emit('users-update', Array.from(users.entries()).map(([id, name]) => ({ id, name })));
      console.log(`${username} registered with ID ${socket.id}`);
    });

    // Call initialization
    socket.on('call-user', (data) => {
      console.log(`User ${socket.id} is calling ${data.userToCall}`);
      io.to(data.userToCall).emit('incoming-call', {
        signal: data.signalData,
        from: socket.id,
        name: users.get(socket.id),
        type: data.type // 'video' or 'voice'
      });
    });

    // Answer call
    socket.on('answer-call', (data) => {
      console.log(`User ${socket.id} answered call from ${data.to}`);
      io.to(data.to).emit('call-accepted', data.signal);
    });

    // Reject call
    socket.on('reject-call', (data) => {
      console.log(`User ${socket.id} rejected call from ${data.to}`);
      io.to(data.to).emit('call-rejected');
    });

    // End call
    socket.on('end-call', (data) => {
      console.log(`User ${socket.id} ended call with ${data.to}`);
      io.to(data.to).emit('call-ended');
    });

    // ICE Candidate
    socket.on('ice-candidate', (data) => {
      io.to(data.to).emit('ice-candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.id}`);
      users.delete(socket.id);
      io.emit('users-update', Array.from(users.entries()).map(([id, name]) => ({ id, name })));
      socket.broadcast.emit('user-disconnected', socket.id);
    });
  });
};
