const express = require('express');
const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Constants
const MAX_CONCURRENT = 2; // Maximum concurrent users in checkout
const AVERAGE_PROCESSING_TIME = 5; // seconds
const DATABASE_FILE = path.join(__dirname, 'database.txt');

// State management
let ticketsAvailable = 0;
const queue = []; // Stores { userId, timestamp }
const activeTokens = new Map(); // Stores { token: { userId, timestamp } }
const mutex = new Mutex(); // Protects access to ticketsAvailable and queue

// Initialize tickets from database.txt
function loadTickets() {
    try {
        const data = fs.readFileSync(DATABASE_FILE, 'utf8');
        const match = data.match(/tickets: (\d+)/);
        if (match && match[1]) {
            ticketsAvailable = parseInt(match[1], 10);
            console.log(`Initial tickets available: ${ticketsAvailable}`);
        } else {
            console.error('Error: "tickets: [count]" not found in database.txt');
            ticketsAvailable = 0; // Default to 0 if not found
        }
    } catch (error) {
        console.error('Error reading database.txt:', error.message);
        ticketsAvailable = 0; // Default to 0 on error
    }
}

function saveTickets() {
    fs.writeFileSync(DATABASE_FILE, `tickets: ${ticketsAvailable}\n`, 'utf8');
}

loadTickets();

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from a 'public' directory

// Root endpoint to serve the waiting room HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Return user ID map for quick lookup of token by userId
function findTokenByUserId(userId) {
    for (const [token, data] of activeTokens) {
        if (data.userId === userId) {
            return token;
        }
    }
    return null;
}

// API to check queue status and get a slot
app.get('/api/cek-antrean', async (req, res) => {
    const userId = req.query.userId || `user_${crypto.randomBytes(8).toString('hex')}`;

    const release = await mutex.acquire();
    try {
        // Check if user already has an active token
        const existingToken = findTokenByUserId(userId);
        if (existingToken) {
            console.log(`User ${userId} already has an active token. Redirecting to checkout.`);
            return res.json({ status: 'redirect', redirectUrl: `/checkout?token=${existingToken}` });
        }

        // Check if user is already in queue - if so, just return queue status
        const existingUserInQueue = queue.find(u => u.userId === userId);
        if (existingUserInQueue) {
            const userPosition = queue.findIndex(u => u.userId === userId) + 1;
            const estimatedTime = Math.ceil((userPosition / MAX_CONCURRENT) * AVERAGE_PROCESSING_TIME);
            return res.json({
                status: 'queued',
                position: userPosition,
                estimatedTime: estimatedTime,
                queueLength: queue.length,
                maxConcurrent: MAX_CONCURRENT
            });
        }

        if (activeTokens.size < MAX_CONCURRENT && ticketsAvailable > 0) {
            // User gets a slot immediately
            const token = crypto.randomBytes(32).toString('hex');
            activeTokens.set(token, { userId, timestamp: Date.now() });
            console.log(`User ${userId} got a slot. Active tokens: ${activeTokens.size}`);
            return res.json({ status: 'redirect', redirectUrl: `/checkout?token=${token}` });
        } else {
            // Place user in queue
            queue.push({ userId, timestamp: Date.now() });
            console.log(`User ${userId} added to queue. Queue length: ${queue.length}`);

            const userPosition = queue.findIndex(u => u.userId === userId) + 1;
            const estimatedTime = Math.ceil((userPosition / MAX_CONCURRENT) * AVERAGE_PROCESSING_TIME);

            return res.json({
                status: 'queued',
                position: userPosition,
                estimatedTime: estimatedTime,
                queueLength: queue.length,
                maxConcurrent: MAX_CONCURRENT
            });
        }
    } finally {
        release();
    }
});

// Checkout page - requires valid token
app.get('/checkout', (req, res) => {
    const { token } = req.query;

    if (!token || !activeTokens.has(token)) {
        return res.status(403).send('403 Access Denied: Invalid or missing token.');
    }

    res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// Payment API - requires valid token
app.post('/api/bayar', async (req, res) => {
    const { token } = req.body;

    if (!token || !activeTokens.has(token)) {
        return res.status(403).json({ message: '403 Access Denied: Invalid or missing token.' });
    }

    const tokenData = activeTokens.get(token);
    const { userId } = tokenData;

    // Simulate payment processing
    console.log(`User ${userId} is attempting payment...`);
    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000)); // 1-3 seconds

    const paymentSuccess = Math.random() > 0.2; // 80% success rate

    // Release semaphore slot and destroy token
    activeTokens.delete(token);

    if (paymentSuccess) {
        if (ticketsAvailable > 0) {
            ticketsAvailable--;
            saveTickets();
            console.log(`Payment successful for ${userId}. Tickets remaining: ${ticketsAvailable}`);
            
            // Move next user from queue to active slot if available
            await processQueue();
            
            return res.json({ status: 'success', message: 'Payment successful!', ticketsRemaining: ticketsAvailable });
        } else {
            console.log(`Payment failed for ${userId}: No tickets left.`);
            
            // Still process queue in case there are users waiting but no tickets
            await processQueue();
            
            return res.status(400).json({ status: 'failed', message: 'No tickets left.' });
        }
    } else {
        console.log(`Payment failed for ${userId}.`);
        
        // Move next user from queue to active slot if available
        await processQueue();
        
        return res.status(400).json({ status: 'failed', message: 'Payment failed, please try again.' });
    }
});

// Function to move users from queue to active slots
async function processQueue() {
    const release = await mutex.acquire();
    try {
        while (activeTokens.size < MAX_CONCURRENT && queue.length > 0 && ticketsAvailable > 0) {
            const nextUser = queue.shift();
            if (nextUser) {
                const token = crypto.randomBytes(32).toString('hex');
                activeTokens.set(token, { userId: nextUser.userId, timestamp: Date.now() });
                console.log(`User ${nextUser.userId} moved from queue to active slot. Active tokens: ${activeTokens.size}`);
                // Client will be notified on next poll to /api/cek-antrean
            }
        }
    } finally {
        release();
    }
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});