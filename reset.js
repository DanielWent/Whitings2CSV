const fs = require('fs');
const path = require('path');

const timestampPath = './.withings2gsheets/withingsprevioustime.json';

if (fs.existsSync(timestampPath)) {
    fs.unlinkSync(timestampPath);
    console.log("Successfully deleted the previous timestamp. The next sync will fetch ALL historical data.");
} else {
    console.log("No timestamp file found. The system is already in a 'fresh' state.");
}
