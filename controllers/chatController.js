const Chat = require('../models/Chat');
const User = require('../models/User');
const mongoose = require('mongoose');

// Get private chat room
exports.getPrivateChatRoom = async (req, res) => {
  try {
    const { cid } = req.params;
    const otherUser = await User.findById(cid).select('profile');
    
    if (!otherUser) {
      req.flash('errors', { msg: 'User not found.' });
      return res.redirect('/donors');
    }

    res.render('chat', {
      title: `Chat with ${otherUser.profile.name}`,
      targetUserId: cid
    });
  } catch (error) {
    console.error('Chat room error:', error);
    req.flash('errors', { msg: 'Error loading chat room.' });
    res.redirect('/donors');
  }
};

// Get chat history between two users
exports.getChatHistory = async (req, res) => {
  try {
    const userId = req.user._id;
    const { otherUserId } = req.params;
    
    const messages = await Chat.find({
      $or: [
        { sender: userId, receiver: otherUserId },
        { sender: otherUserId, receiver: userId }
      ]
    })
    .sort({ createdAt: 1 })
    .lean();

    res.json({ 
      success: true, 
      messages: messages.map(msg => ({
        message: msg.message,
        sender: msg.sender,
        createdAt: msg.createdAt
      }))
    });
  } catch (error) {
    console.error('Error in getChatHistory:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get all chat conversations for a user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get all unique conversations
    const conversations = await Chat.aggregate([
      {
        $match: {
          $or: [
            { sender: new mongoose.Types.ObjectId(userId) },
            { receiver: new mongoose.Types.ObjectId(userId) }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: {
              if: { $eq: ["$sender", new mongoose.Types.ObjectId(userId)] },
              then: "$receiver",
              else: "$sender"
            }
          },
          lastMessage: { $first: "$$ROOT" }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "otherUser"
        }
      },
      {
        $unwind: "$otherUser"
      }
    ]);

    // Get unread count for each conversation
    const conversationsWithCounts = await Promise.all(
      conversations.map(async (conv) => {
        const unreadCount = await Chat.countDocuments({
          sender: conv._id,
          receiver: userId,
          read: false
        });

        return {
          otherUser: {
            _id: conv.otherUser._id,
            profile: conv.otherUser.profile
          },
          lastMessage: {
            content: conv.lastMessage.message,
            createdAt: conv.lastMessage.createdAt
          },
          unreadCount
        };
      })
    );

    res.json({
      success: true,
      conversations: conversationsWithCounts
    });
  } catch (error) {
    console.error('Error in getConversations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark messages as read
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const { otherUserId } = req.params;

    await Chat.updateMany(
      {
        sender: otherUserId,
        receiver: userId,
        read: false
      },
      {
        $set: { read: true }
      }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error in markAsRead:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}; 