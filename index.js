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

    if (fs.existsSync(config.token_path)) {
        const tokens = JSON.parse(fs.readFileSync(config.token_path));
        const currentTime = Math.floor(Date.now() / 1000);
        
        // This will now call the updated function in utils.js
        await utils.getWithingsData(tokens.accessToken, tokens.refreshToken, currentTime);
    } else {
        console.log("No tokens found. Please run Manual Token Setup first.");
    }
}

doEverything().then(() => {
    console.log("Process finished. Shutting down.");
    process.exit(0);
}).catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
