const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
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

// 2. SMART WALLET API
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone } = req.body;
    
    // Config for Paystack
    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        console.log(`Creating wallet for: ${email}`);
        
        // A. Try to Create New Customer
        const response = await axios.post('https://api.paystack.co/customer', { 
            email, first_name: firstName, last_name: lastName, phone 
        }, config);

        // Success! (New User)
        res.json({ 
            status: 'success', 
            data: {
                customer_code: response.data.data.customer_code,
                account_number: phone // Using phone as account number
            }
        });

    } catch (error) {
        // B. Handle "User Already Exists" Error
        if (error.response && error.response.status === 400) {
            console.log("User exists! Fetching details instead...");
            
            try {
                // Fetch the existing user from Paystack
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                
                // Return Success! (Existing User)
                res.json({ 
                    status: 'success', 
                    data: {
                        customer_code: fetchRes.data.data.customer_code,
                        account_number: fetchRes.data.data.phone || phone
                    }
                });
            } catch (fetchErr) {
                // If fetching also fails, then it's a real error
                console.error("Fetch Failed:", fetchErr.message);
                res.status(500).json({ status: 'error', error: "Could not recover existing account." });
            }
        } else {
            // Some other error (Connection, Key, etc.)
            console.error("Paystack Error:", error.message);
            res.status(500).json({ status: 'error', error: "Connection to Payment Server Failed" });
        }
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log(`F8FU Server running on port ${PORT}`);
});
