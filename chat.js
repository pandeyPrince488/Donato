const socketIO = require('socket.io');
const Chat = require('./models/Chat');
const User = require('./models/User');
const mongoose = require('mongoose');

function initializeChat(server) {
  const io = socketIO(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.use(async (socket, next) => {
    const userId = socket.handshake.auth.userId;
    const token = socket.handshake.auth.token;
    if (!userId || !token) {
      return next(new Error('invalid credentials'));
    }
    try {
      const user = await User.findById(userId);
      if (!user) {
        return next(new Error('user not found'));
      }
      socket.userId = userId;
      socket.user = user;
      next();
    } catch (error) {
      return next(new Error('authentication failed'));
    }
  });

  const onlineUsers = new Map();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.userId);
    
    // Add user to online users
    onlineUsers.set(socket.userId, socket.id);

    // Handle private messages
    socket.on('private message', async (data) => {
      try {
        const { content, to } = data;
        const from = socket.userId;

        if (!content || !to) {
          throw new Error('Message content and recipient are required');
        }

        // Save message to database
        const chat = new Chat({
          sender: from,
          receiver: to,
          message: content,
          read: false
        });
        await chat.save();

        // Send to receiver if online
        const receiverSocketId = onlineUsers.get(to);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('private message', {
            content: chat.message,
            from: chat.sender,
            createdAt: chat.createdAt
          });
        }

      } catch (error) {
        console.error('Error in private message:', error);
        socket.emit('chat error', { message: error.message });
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.userId);
      onlineUsers.delete(socket.userId);
    });
  });

  return io;
}

module.exports = { initializeChat };
