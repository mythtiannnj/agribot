const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');
const IMAGES_FOLDER = path.join(__dirname, 'generated_images');

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/images', express.static(IMAGES_FOLDER));

// Rate limiting
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60;

function rateLimiter(req, res, next) {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimit.has(clientIP)) {
        rateLimit.set(clientIP, []);
    }
    
    const timestamps = rateLimit.get(clientIP);
    const recentRequests = timestamps.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Please wait a moment before making more requests',
            retryAfter: Math.ceil((RATE_LIMIT_WINDOW - (now - recentRequests[0])) / 1000)
        });
    }
    
    recentRequests.push(now);
    rateLimit.set(clientIP, recentRequests);
    next();
}

// Apply rate limiting to API routes
app.use('/api', rateLimiter);

// Initialize conversations storage
let conversations = {};
let conversationCounter = 0;

// Ensure images folder exists
async function ensureImagesFolder() {
    try {
        await fs.mkdir(IMAGES_FOLDER, { recursive: true });
        console.log('📁 Images folder ready');
    } catch (error) {
        console.error('Error creating images folder:', error);
    }
}

// Load conversations from file
async function loadConversations() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        conversations = JSON.parse(data);
        // Find highest conversation ID
        Object.keys(conversations).forEach(id => {
            const num = parseInt(id.replace('conv_', ''));
            if (num > conversationCounter) conversationCounter = num;
        });
        console.log(`📂 Loaded ${Object.keys(conversations).length} conversations`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📝 No existing conversations found, starting fresh');
            conversations = {};
        } else {
            console.error('Error loading conversations:', error);
        }
    }
}

// Save conversations to file with backup
async function saveConversations() {
    try {
        // Create backup of existing file
        try {
            await fs.copyFile(CONVERSATIONS_FILE, `${CONVERSATIONS_FILE}.backup`);
        } catch (error) {
            // No existing file to backup
        }
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
        console.log('💾 Conversations saved successfully');
    } catch (error) {
        console.error('Error saving conversations:', error);
    }
}

// Agricultural context for the AI
const AGRICULTURAL_SYSTEM_PROMPT = `You are AgriBot, an expert agricultural assistant with deep knowledge of:
- Modern farming techniques and sustainable agriculture
- Crop management, soil health, and irrigation systems
- Agricultural technology, precision farming, and IoT in agriculture
- Market trends, agricultural economics, and supply chains
- Climate-smart agriculture and environmental sustainability
- Pest control, organic farming, and biotechnology
- Agricultural policies and rural development
- Animal science, livestock management, and veterinary practices
- Plant biology, genetics, and microbiology
- Soil science, fertility management, and conservation

Provide practical, actionable advice for farmers, agronomists, and agricultural professionals. 
Be conversational, helpful, and focus on agricultural topics. 
If the user asks for images or visual content, suggest using the image generation feature.
Always provide detailed, accurate, and scientifically-based responses.`;

// Check if message is requesting an image
function isImageRequest(message) {
    const imageKeywords = [
        'image', 'picture', 'photo', 'generate image', 'create image',
        'show me', 'visual', 'draw', 'illustration', 'diagram',
        '生成图片', '图片', '图像', '显示图片', 'generate visual',
        'create picture', 'make image', 'produce image', 'generate photo'
    ];
    
    const lowerMessage = message.toLowerCase();
    return imageKeywords.some(keyword => lowerMessage.includes(keyword));
}

// Sanitize filename for downloads
function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-z0-9]/gi, '_')
        .toLowerCase()
        .substring(0, 100);
}

// Generate unique image ID
function generateImageId() {
    return `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Download and save image locally
async function downloadAndSaveImage(imageUrl, prompt) {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status}`);
        }
        
        const buffer = await response.buffer();
        const imageId = generateImageId();
        const filename = `${imageId}.jpg`;
        const filepath = path.join(IMAGES_FOLDER, filename);
        
        await fs.writeFile(filepath, buffer);
        
        return {
            localUrl: `/images/${filename}`,
            filename: filename,
            id: imageId,
            size: buffer.length,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('Error saving image locally:', error);
        return null;
    }
}

// Format duration helper
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// ==================== API ENDPOINTS ====================

// Health check endpoint
app.get('/api/health', (req, res) => {
    const healthInfo = {
        status: 'healthy',
        service: 'AgriConnect Pro',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        conversations: Object.keys(conversations).length,
        totalMessages: Object.values(conversations).reduce((sum, conv) => sum + conv.messages.length, 0),
        uptime: formatDuration(process.uptime() * 1000),
        memory: {
            used: process.memoryUsage().heapUsed,
            total: process.memoryUsage().heapTotal,
            formatted: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
        },
        endpoints: {
            chat: '/api/chat',
            generateImage: '/api/generate-image',
            conversations: '/api/conversations',
            suggestions: '/api/suggestions',
            export: '/api/export',
            import: '/api/import',
            downloadImage: '/api/download-image'
        }
    };
    
    res.json(healthInfo);
});

// API endpoint for conversational AI
app.post('/api/chat', async (req, res) => {
    try {
        const { message, conversationId = null, history = [] } = req.body;
        
        if (!message || message.trim() === '') {
            return res.status(400).json({ 
                error: 'Bad Request',
                message: 'Message is required' 
            });
        }

        // Check if image generation is requested
        if (isImageRequest(message)) {
            return res.json({
                response: "I can generate an agricultural image for you! Please use the image generation feature by clicking the 🎨 button or toggle to image mode.",
                type: 'image_suggestion',
                suggestImageGeneration: true,
                timestamp: new Date().toISOString()
            });
        }

        // Get or create conversation
        let currentConversationId = conversationId;
        if (!currentConversationId || !conversations[currentConversationId]) {
            currentConversationId = `conv_${++conversationCounter}`;
            conversations[currentConversationId] = {
                id: currentConversationId,
                title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                messages: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }

        // Update conversation history
        const conversation = conversations[currentConversationId];
        conversation.messages.push({
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        });

        // Prepare history for AI (last 10 messages)
        const aiHistory = conversation.messages.slice(-10).map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // Call external AI API with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout
        
        try {
            const apiUrl = 'https://jonell.ccprojects.gleeze.com/api/gptoss';
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    prompt: message,
                    system: AGRICULTURAL_SYSTEM_PROMPT,
                    temperature: 0.7,
                    history: aiHistory
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`API responded with status ${response.status}`);
            }

            const data = await response.json();
            const aiResponse = data.response || 'I apologize, but I couldn\'t process that agricultural query.';
            
            // Save AI response to conversation
            conversation.messages.push({
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date().toISOString()
            });
            conversation.updatedAt = new Date().toISOString();

            // Save conversations to file
            await saveConversations();

            res.json({
                response: aiResponse,
                conversationId: currentConversationId,
                type: 'text',
                timestamp: new Date().toISOString()
            });
        } finally {
            clearTimeout(timeout);
        }

    } catch (error) {
        console.error('Error calling AI API:', error);
        
        if (error.name === 'AbortError') {
            return res.status(504).json({ 
                error: 'Gateway Timeout',
                message: 'AI service took too long to respond. Please try again.' 
            });
        }
        
        res.status(500).json({ 
            error: 'Internal Server Error',
            message: 'Failed to get response from AI service',
            details: error.message 
        });
    }
});

// Enhanced image generation endpoint
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt, saveLocally = true } = req.body;
        
        if (!prompt || prompt.trim() === '') {
            return res.status(400).json({ 
                error: 'Bad Request',
                message: 'Prompt is required for image generation' 
            });
        }

        // Enhance agricultural context for better images
        const enhancedPrompt = `Agricultural scene: ${prompt}, high quality, professional photography, natural lighting, detailed`;
        
        const apiUrl = `https://kryptonite-api-library.vercel.app/api/pollinations?prompt=${encodeURIComponent(enhancedPrompt)}`;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout
        
        try {
            const response = await fetch(apiUrl, { signal: controller.signal });
            
            if (!response.ok) {
                throw new Error(`Image API responded with status ${response.status}`);
            }

            const data = await response.json();
            const imageUrl = data.image || data.url || data.imageUrl;
            
            if (!imageUrl) {
                throw new Error('No image URL in response');
            }

            // Save image locally if requested
            let localImageInfo = null;
            if (saveLocally) {
                localImageInfo = await downloadAndSaveImage(imageUrl, prompt);
            }

            res.json({
                success: true,
                imageUrl: imageUrl,
                localImage: localImageInfo,
                prompt: prompt,
                enhancedPrompt: enhancedPrompt,
                timestamp: new Date().toISOString()
            });
        } finally {
            clearTimeout(timeout);
        }

    } catch (error) {
        console.error('Error generating image:', error);
        
        if (error.name === 'AbortError') {
            return res.status(504).json({ 
                error: 'Gateway Timeout',
                message: 'Image generation took too long. Please try again.' 
            });
        }
        
        res.status(500).json({ 
            error: 'Image Generation Failed',
            message: error.message 
        });
    }
});

// Download image endpoint
app.get('/api/download-image', async (req, res) => {
    try {
        const { imageUrl, filename } = req.query;
        
        if (!imageUrl) {
            return res.status(400).json({ 
                error: 'Bad Request',
                message: 'Image URL is required' 
            });
        }

        // Fetch image from external URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
        }

        const buffer = await response.buffer();
        const downloadFilename = filename ? sanitizeFilename(filename) : 'agricultural-image.jpg';
        
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);
        
    } catch (error) {
        console.error('Error downloading image:', error);
        res.status(500).json({ 
            error: 'Download Failed',
            message: error.message 
        });
    }
});

// Get all conversations
app.get('/api/conversations', async (req, res) => {
    try {
        const { search, limit, offset } = req.query;
        
        let conversationList = Object.values(conversations).map(conv => ({
            id: conv.id,
            title: conv.title,
            messageCount: conv.messages.length,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            lastMessage: conv.messages[conv.messages.length - 1]?.content?.substring(0, 100)
        }));
        
        // Search filter
        if (search) {
            const searchLower = search.toLowerCase();
            conversationList = conversationList.filter(conv => 
                conv.title.toLowerCase().includes(searchLower) ||
                conv.lastMessage?.toLowerCase().includes(searchLower)
            );
        }
        
        // Sort by updatedAt descending
        conversationList.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        
        // Pagination
        const total = conversationList.length;
        if (limit) {
            const start = parseInt(offset) || 0;
            const end = start + parseInt(limit);
            conversationList = conversationList.slice(start, end);
        }
        
        res.json({ 
            conversations: conversationList,
            total,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error getting conversations:', error);
        res.status(500).json({ error: 'Failed to get conversations' });
    }
});

// Get specific conversation
app.get('/api/conversations/:id', async (req, res) => {
    try {
        const conversationId = req.params.id;
        const conversation = conversations[conversationId];
        
        if (!conversation) {
            return res.status(404).json({ 
                error: 'Not Found',
                message: 'Conversation not found' 
            });
        }
        
        // Add statistics
        const userMessages = conversation.messages.filter(msg => msg.role === 'user').length;
        const botMessages = conversation.messages.filter(msg => msg.role === 'assistant').length;
        const duration = new Date(conversation.updatedAt) - new Date(conversation.createdAt);
        
        res.json({ 
            conversation: {
                ...conversation,
                stats: {
                    userMessages,
                    botMessages,
                    totalMessages: conversation.messages.length,
                    durationMs: duration,
                    durationFormatted: formatDuration(duration)
                }
            }
        });
    } catch (error) {
        console.error('Error getting conversation:', error);
        res.status(500).json({ error: 'Failed to get conversation' });
    }
});

// Update conversation title
app.put('/api/conversations/:id/title', async (req, res) => {
    try {
        const conversationId = req.params.id;
        const { title } = req.body;
        
        if (!conversations[conversationId]) {
            return res.status(404).json({ 
                error: 'Not Found',
                message: 'Conversation not found' 
            });
        }
        
        if (!title || title.trim() === '') {
            return res.status(400).json({ 
                error: 'Bad Request',
                message: 'Title is required' 
            });
        }
        
        conversations[conversationId].title = title.trim();
        conversations[conversationId].updatedAt = new Date().toISOString();
        
        await saveConversations();
        
        res.json({ 
            success: true,
            conversation: conversations[conversationId]
        });
    } catch (error) {
        console.error('Error updating conversation:', error);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

// Delete specific conversation
app.delete('/api/conversations/:id', async (req, res) => {
    try {
        const conversationId = req.params.id;
        
        if (!conversations[conversationId]) {
            return res.status(404).json({ 
                error: 'Not Found',
                message: 'Conversation not found' 
            });
        }
        
        delete conversations[conversationId];
        await saveConversations();
        
        res.json({ 
            success: true, 
            message: 'Conversation deleted',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error deleting conversation:', error);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

// Clear all conversations
app.delete('/api/conversations', async (req, res) => {
    try {
        const count = Object.keys(conversations).length;
        conversations = {};
        conversationCounter = 0;
        await saveConversations();
        
        res.json({ 
            success: true, 
            message: `Cleared ${count} conversations`,
            clearedCount: count,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error clearing conversations:', error);
        res.status(500).json({ error: 'Failed to clear conversations' });
    }
});

// Export conversations
app.get('/api/export', async (req, res) => {
    try {
        const exportData = {
            exportDate: new Date().toISOString(),
            version: '2.0.0',
            conversations: conversations,
            stats: {
                totalConversations: Object.keys(conversations).length,
                totalMessages: Object.values(conversations).reduce((sum, conv) => sum + conv.messages.length, 0)
            }
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="agriconnect-export.json"');
        res.json(exportData);
    } catch (error) {
        console.error('Error exporting conversations:', error);
        res.status(500).json({ error: 'Failed to export conversations' });
    }
});

// Import conversations
app.post('/api/import', async (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.conversations || typeof importData.conversations !== 'object') {
            return res.status(400).json({ 
                error: 'Bad Request',
                message: 'Invalid import data' 
            });
        }
        
        let importedCount = 0;
        Object.entries(importData.conversations).forEach(([id, conversation]) => {
            if (!conversations[id]) {
                conversations[id] = conversation;
                importedCount++;
                
                const num = parseInt(id.replace('conv_', ''));
                if (num > conversationCounter) conversationCounter = num;
            }
        });
        
        await saveConversations();
        
        res.json({ 
            success: true,
            importedCount,
            totalConversations: Object.keys(conversations).length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error importing conversations:', error);
        res.status(500).json({ error: 'Failed to import conversations' });
    }
});

// Suggestion endpoints for agricultural topics
app.get('/api/suggestions', (req, res) => {
    const { category } = req.query;
    
    const allSuggestions = {
        general: [
            "🌾 What are the best practices for sustainable wheat farming?",
            "💧 How can I implement efficient drip irrigation systems?",
            "🌱 What are the benefits of crop rotation for soil health?",
            "🐛 Organic pest control methods for tomato crops?",
            "📊 Current market trends in agricultural commodities?",
            "🤖 How is AI transforming modern agriculture?",
            "🌍 Climate-smart farming techniques for small farms?",
            "💡 Tips for starting an urban farming project?"
        ],
        'animal-science': [
            "🐄 What are the best practices for cattle breeding?",
            "🐔 How to maintain optimal poultry nutrition?",
            "🐷 Common diseases in livestock and prevention?",
            "🥛 How to set up a sustainable dairy farm?"
        ],
        biology: [
            "🧬 How does photosynthesis work in plants?",
            "🔬 What are the basics of plant genetics?",
            "🌱 How do GMO crops differ from traditional crops?",
            "🦠 How do microorganisms affect soil fertility?"
        ],
        'crop-production': [
            "🌾 What are the best practices for wheat cultivation?",
            "🌽 How to maximize corn yield?",
            "🌾 What are the optimal conditions for rice farming?",
            "🥬 How to manage crop rotation effectively?"
        ],
        'soil-science': [
            "🌍 How to test soil quality?",
            "🧪 What are the different types of soil?",
            "🌱 How to improve soil fertility naturally?",
            "💧 How to prevent soil erosion?"
        ]
    };
    
    const suggestions = category && allSuggestions[category] 
        ? allSuggestions[category] 
        : allSuggestions.general;
    
    res.json({ 
        suggestions,
        categories: Object.keys(allSuggestions),
        timestamp: new Date().toISOString()
    });
});

// 404 handler for API routes
app.use('/api', (req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        message: 'API endpoint not found',
        path: req.path
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// 404 handler - serve custom 404 page
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'frontend', '404.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    // Check if it's an API request
    if (req.path.startsWith('/api/')) {
        return res.status(500).json({
            error: 'Internal Server Error',
            message: 'Something went wrong on the server',
            requestId: crypto.randomBytes(8).toString('hex')
        });
    }
    
    // Serve custom 500 page for web requests
    res.status(500).sendFile(path.join(__dirname, 'frontend', '500.html'));
});

// Initialize and start server
async function startServer() {
    await ensureImagesFolder();
    await loadConversations();
    
    app.listen(PORT, () => {
        console.log('=================================');
        console.log('🌱 AgriConnect Pro Server Started');
        console.log('=================================');
        console.log(`📍 Server URL: http://localhost:${PORT}`);
        console.log(`💬 Chat API: http://localhost:${PORT}/api/chat`);
        console.log(`🎨 Image API: http://localhost:${PORT}/api/generate-image`);
        console.log(`💾 Conversations: ${Object.keys(conversations).length} stored`);
        console.log(`📁 Images folder: ${IMAGES_FOLDER}`);
        console.log('=================================');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n📦 Saving conversations before shutdown...');
    await saveConversations();
    console.log('✅ Conversations saved. Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n📦 Saving conversations before shutdown...');
    await saveConversations();
    console.log('✅ Conversations saved. Goodbye!');
    process.exit(0);
});

// Start the server
startServer();