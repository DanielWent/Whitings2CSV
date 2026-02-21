const express = require('express');
const app = express();
const config = require('./config');
const utils = require('./utils');
const fs = require('fs');

async function doEverything() {
    console.log("Starting Withings Sync Process...");
    
    if (!fs.existsSync(config.output_dir)) {
        fs.mkdirSync(config.output_dir, { recursive: true });
    }

    // Loop through each user defined in config.js
    for (const user of config.users) {
        console.log(`\n--- Processing User: ${user.id} ---`);
        
        if (fs.existsSync(user.token_path)) {
            const tokens = JSON.parse(fs.readFileSync(user.token_path));
            const currentTime = Math.floor(Date.now() / 1000);
            
            // Pass the specific 'user' object to the utils function
            await utils.getWithingsData(tokens.accessToken, tokens.refreshToken, currentTime, user);
        } else {
            console.log(`No tokens found for ${user.id} at ${user.token_path}.`);
        }
    }
}

doEverything().then(() => {
    console.log("\nAll users processed. Shutting down.");
    process.exit(0);
}).catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
