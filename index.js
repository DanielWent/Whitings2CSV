const express = require('express');
const app = express();
const config = require('./config');
const utils = require('./utils');
const fs = require('fs');

async function doEverything() {
    console.log("Starting Withings Sync Process...");
    
    console.log(`Checking output directory: ${config.output_dir}`);
    if (!fs.existsSync(config.output_dir)) {
        console.log(`Output directory does not exist. Creating: ${config.output_dir}`);
        fs.mkdirSync(config.output_dir, { recursive: true });
    } else {
        console.log(`Output directory exists: ${config.output_dir}`);
    }

    if (!config.users || config.users.length === 0) {
        console.warn("WARNING: No users defined in config.js");
    }

    // Loop through each user defined in config.js
    for (const user of config.users) {
        console.log(`\n--- Processing User: ${user.id} ---`);
        console.log(`Checking for token file at: ${user.token_path}`);
        
        if (fs.existsSync(user.token_path)) {
            try {
                console.log(`Token file found for ${user.id}. Reading contents...`);
                const tokenData = fs.readFileSync(user.token_path, 'utf8');
                const tokens = JSON.parse(tokenData);
                
                if (!tokens.accessToken || !tokens.refreshToken) {
                    console.warn(`WARNING: Missing accessToken or refreshToken in ${user.token_path}`);
                }
                
                const currentTime = Math.floor(Date.now() / 1000);
                console.log(`Current UNIX time: ${currentTime}`);
                console.log(`Initiating utils.getWithingsData for ${user.id}...`);
                
                // Pass the specific 'user' object to the utils function
                await utils.getWithingsData(tokens.accessToken, tokens.refreshToken, currentTime, user);
                console.log(`Successfully completed utils.getWithingsData for ${user.id}`);
            } catch (error) {
                console.error(`ERROR processing user ${user.id}:`, error.message);
                console.error(error.stack);
            }
        } else {
            console.log(`No tokens found for ${user.id} at ${user.token_path}. Skipping.`);
        }
    }
}

doEverything().then(() => {
    console.log("\nAll users processed. Shutting down.");
    process.exit(0);
}).catch(err => {
    console.error("Fatal Error in doEverything():", err.message);
    console.error(err.stack);
    process.exit(1);
});
