const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto'); // Needed to verify Paystack security
const admin = require('firebase-admin'); // Needed to update database
require('dotenv').config();

// SETUP FIREBASE ADMIN (To update wallet balances securely)
// Note: For a live app, you'd use a service account key here.
// For this demo, we will simulate the update logic or use basic config.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

// Initialize App
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. CALCULATOR API
app.post('/api/split', (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: "No amount" });
    const amt = parseFloat(amount);
    res.json({
        savings: amt * 0.20,
        tithe: amt * 0.10,
        investment: amt * 0.40,
        needs: amt * 0.30
    });
});

// 2. CREATE WALLET API
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone } = req.body;
    
    // Check Config
    if (!process.env.PAYSTACK_SECRET) {
        return res.status(500).json({ status: 'error', error: "Server Key Missing" });
    }

    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        console.log(`Creating wallet for: ${email}`);
        
        // Create User on Paystack
        const response = await axios.post('https://api.paystack.co/customer', { 
            email, first_name: firstName, last_name: lastName, phone 
        }, config);

        // Success (New User)
        res.json({ 
            status: 'success', 
            data: {
                customer_code: response.data.data.customer_code,
                // If DVA is enabled, Paystack usually returns the nuban here in 'dedicated_account'
                // For now we fallback to phone number if no real account exists yet.
                account_number: phone 
            }
        });

    } catch (error) {
        // Handle User Exists
        if (error.response && error.response.status === 400) {
            try {
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                res.json({ 
                    status: 'success', 
                    data: {
                        customer_code: fetchRes.data.data.customer_code,
                        account_number: fetchRes.data.data.phone || phone
                    }
                });
            } catch (fetchErr) {
                res.status(500).json({ status: 'error', error: "Account recovery failed." });
            }
        } else {
            const msg = error.response?.data?.message || "Payment Server Error";
            res.status(500).json({ status: 'error', error: msg });
        }
    }
});

// 3. THE WEBHOOK (This listens for Money!)
app.post('/api/webhook', (req, res) => {
    // A. Security Check: Is this really from Paystack?
    const secret = process.env.PAYSTACK_SECRET;
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
        // Stop hackers sending fake deposit alerts
        return res.status(400).send('Invalid signature'); 
    }

    // B. Check Event Type
    const event = req.body;
    if (event.event === 'charge.success') {
        const amount = event.data.amount / 100; // Paystack sends kobo, convert to Naira
        const email = event.data.customer.email;
        
        console.log(`💰 DEPOSIT RECEIVED: ₦${amount} from ${email}`);
        
        // HERE is where we would update the Firestore Database
        // For now, we just log it to the console (Viewable in Render Logs)
        console.log("--> Action: Update User Wallet Balance + " + amount);
    }

    res.sendStatus(200); // Tell Paystack "We got it, thanks!"
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log(`F8FU Server running on port ${PORT}`);
});
