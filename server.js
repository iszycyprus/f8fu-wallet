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

// 2. CREATE WALLET API (With BVN for Real Accounts)
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone, bvn } = req.body; // <--- ADDED BVN
    
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
        
        // 1. Create Customer WITH BVN
        // Paystack uses 'customer' endpoint to save KYC info
        const customerData = { 
            email, 
            first_name: firstName, 
            last_name: lastName, 
            phone,
            metadata: { bvn: bvn } // Some integrations require this, but see step 2
        };

        const response = await axios.post('https://api.paystack.co/customer', customerData, config);
        const customerCode = response.data.data.customer_code;

        // 2. Validate Customer (The KYC Step)
        // For DVA to work live, we often need to explicitly validate the customer
        // However, if you enabled "Auto-create DVA" in Paystack settings, 
        // passing the data might be enough. 
        
        // For this code, we return the data. 
        // If you are in LIVE mode, Paystack will generate a real NUBAN if KYC passes.
        
        let accountNum = phone; // Fallback
        
        // Check if Paystack gave us a dedicated account immediately
        if (response.data.data.dedicated_account) {
            accountNum = response.data.data.dedicated_account.account_number;
        }

        res.json({ 
            status: 'success', 
            data: {
                customer_code: customerCode,
                account_number: accountNum
            }
        });

    } catch (error) {
        // Handle User Exists
        if (error.response && error.response.status === 400) {
            try {
                // If user exists, we fetch them. 
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                res.json({ 
                    status: 'success', 
                    data: {
                        customer_code: fetchRes.data.data.customer_code,
                        account_number: fetchRes.data.data.phone || phone // Fallback
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
