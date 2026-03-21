const fs = require('fs');
const util = require('util');

// --- GLOBAL LOG FILE OVERRIDE ---
// This intercepts all console output and forces it into a physical file
const logFile = './sync-debug.log';
fs.writeFileSync(logFile, `=== STARTING SYNC RUN: ${new Date().toISOString()} ===\n`);

const logStdout = process.stdout;
const logStderr = process.stderr;

console.log = function() {
    const msg = util.format.apply(null, arguments) + '\n';
    fs.appendFileSync(logFile, msg);
    logStdout.write(msg);
};
console.error = function() {
    const msg = '[ERROR] ' + util.format.apply(null, arguments) + '\n';
    fs.appendFileSync(logFile, msg);
    logStderr.write(msg);
};
console.warn = function() {
    const msg = '[WARN] ' + util.format.apply(null, arguments) + '\n';
    fs.appendFileSync(logFile, msg);
    logStderr.write(msg);
};
// --------------------------------

const express = require('express');
const app = express();
const config = require('./config');
const utils = require('./utils');

async function doEverything() {
    console.log("Starting Withings Sync Process...");
    
    if (!fs.existsSync(config.output_dir)) {
        console.log(`Creating output directory: ${config.output_dir}`);
        fs.mkdirSync(config.output_dir, { recursive: true });
    }

    if (!config.users || config.users.length === 0) {
        console.error("No users defined in config.users!");
        return;
    }

    // Loop through each user defined in config.js
    for (const user of config.users) {
        console.log(`\n--- Processing User: ${user.id} ---`);
        
        if (fs.existsSync(user.token_path)) {
            try {
                console.log(`Reading tokens from ${user.token_path}`);
                const tokenData = fs.readFileSync(user.token_path, 'utf8');
                const tokens = JSON.parse(tokenData);
                const currentTime = Math.floor(Date.now() / 1000);
                
                console.log(`Current UNIX time evaluated as: ${currentTime}`);
                await utils.getWithingsData(tokens.accessToken, tokens.refreshToken, currentTime, user);
            } catch (err) {
                console.error(`Failed during processing for user ${user.id}:`, err.message);
                console.error(err.stack);
            }
        } else {
            console.log(`No tokens found for ${user.id} at ${user.token_path}. Skipping.`);
        }
    }
}

doEverything().then(() => {
    console.log("\nAll users processed. Shutting down normally.");
    process.exit(0);
}).catch(err => {
    console.error("Fatal unhandled error in doEverything:", err.message);
    console.error(err.stack);
    process.exit(1);
});
