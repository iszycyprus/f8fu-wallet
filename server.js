const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
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

// 2. WALLET CREATION API (Hides Paystack Key)
app.post('/api/create-wallet', async (req, res) => {
    try {
        const { firstName, lastName, email, phone } = req.body;
        
        // Call Paystack securely from the server
        const response = await axios.post(
            'https://api.paystack.co/customer',
            { 
                email: email,
                first_name: firstName,
                last_name: lastName,
                phone: phone
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Send only the result back to the phone
        if (response.data.status) {
            res.json({ status: 'success', data: {
                customer_code: response.data.data.customer_code,
                account_number: "20" + phone.slice(-8) // Simulated NUBAN for demo
            }});
        } else {
            res.status(400).json({ status: 'error', error: response.data.message });
        }

    } catch (error) {
        console.error("Paystack Error:", error.response?.data || error.message);
        res.status(500).json({ status: 'error', error: "Payment Provider Error" });
    }
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log(`F8FU Server running on port ${PORT}`);
});
