const express = require('express');
const app = express();
const config = require('./utils/config'); // Ensure this path is correct for your repo
const utils = require('./utils/utils');
const fs = require('fs');
const path = require('path');

const port = 5005;

async function doEverything() {
    console.log("Starting Withings Sync Process...");
    
    // Ensure data directory exists
    if (!fs.existsSync(config.output_dir)) {
        fs.mkdirSync(config.output_dir, { recursive: true });
    }

    if (fs.existsSync(config.token_path)) {
        const tokens = JSON.parse(fs.readFileSync(config.token_path));
        const currentTime = Math.floor(Date.now() / 1000);
        
        await utils.getWithingsData(tokens.accessToken, tokens.refreshToken, currentTime);
    } else {
        console.log("No tokens found. Please run Manual Token Setup first.");
    }
}

// Start the orchestrator
doEverything().then(() => {
    console.log("Process finished. Shutting down.");
    process.exit(0);
}).catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
