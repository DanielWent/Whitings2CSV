const fs = require('fs');
const config = require('./config');

console.log("Starting historical data reset...");

let filesDeleted = 0;

config.users.forEach(user => {
    if (fs.existsSync(user.timestamp_path)) {
        try {
            fs.unlinkSync(user.timestamp_path);
            console.log(`[${user.id}] Successfully deleted timestamp: ${user.timestamp_path}`);
            filesDeleted++;
        } catch (err) {
            console.error(`[${user.id}] Failed to delete timestamp: ${err.message}`);
        }
    } else {
        console.log(`[${user.id}] No timestamp file found at ${user.timestamp_path}. Already fresh.`);
    }
});

if (filesDeleted > 0) {
    console.log(`\nReset complete. ${filesDeleted} user(s) will fetch ALL historical data on the next sync.`);
} else {
    console.log("\nNo action taken. All users are already in a fresh state.");
}
