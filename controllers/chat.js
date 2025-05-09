/**
 * GET /c/:cid
 * Home page.
 */
exports.getPrivateChatRoom = (req, res) => {
  console.log(req.params.cid);
  res.render('chat', {
    title: 'Chat room'
  });
};

const Chat = require('../models/Chat');
const User = require('../models/User');

// Get chat history between two users
exports.getChatHistory = async (req, res) => {
  try {
    const { userId } = req.user; // Changed from req to req.user
    const { otherUserId } = req.params;
    
    const messages = await Chat.find({
      $or: [
        { sender: userId, receiver: otherUserId },
        { sender: otherUserId, receiver: userId }
      ]
    })
    .sort({ createdAt: 1 })
    .populate('sender', 'name profileImage')
    .populate('receiver', 'name profileImage');

    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get all chat conversations for a user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user._id; // Changed from req.userId to req.user._id

    // Get the last message from each conversation
    const conversations = await Chat.aggregate([
      {
        $match: {
          $or: [{ sender: userId }, { receiver: userId }]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: {
              if: { $eq: ["$sender", userId] },
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
      },
      {
        $project: {
          otherUser: {
            _id: 1,
            name: 1,
            profileImage: 1
          },
          lastMessage: 1,
          unreadCount: 1
        }
      }
    ]);

    // Get unread count for each conversation
    for (let conv of conversations) {
      conv.unreadCount = await Chat.countDocuments({
        sender: conv._id,
        receiver: userId,
        read: false
      });
    }

    res.json({ success: true, conversations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark messages as read
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user._id; // Changed from req.userId to req.user._id
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
    res.status(500).json({ success: false, error: error.message });
  }
};
