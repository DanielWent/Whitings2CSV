var config = require('./config');
const { google } = require('googleapis'); // Added Google Drive API
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
let conor = require('./conor.js');

// Replaced LevelDB with SQLite due to clash with Dropbox syncing
let db = new sqlite3.Database(config.sqlite3_output_path, (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to sqlite3.');
});

const { GoogleSpreadsheet } = require('google-spreadsheet');

// Find out when the code was last run
function getPreviousTimestamp() {
    try {
        timestamp = fs.readFileSync(config.timestamp_path);
    } catch (err) {
        // console.log("No previous timestamp")
        // If we haven't run before, return 0 (Jan 1 1970)
        return 0;
    }
    // If timestamp exists, read it
    let previousTimestamp = JSON.parse(timestamp);
    return previousTimestamp;
}

// If access token is no longer working, then this is called.
async function getReplacementAccessToken(refreshToken) {
    var bodyFormData = new FormData();

    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);

    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, {
            headers: {
                ...bodyFormData.getHeaders()
            }
        })
        const accessToken = response.data.body.access_token;
        const refreshToken = response.data.body.refresh_token;

        if ((typeof accessToken !== "undefined") && (typeof refreshToken !== "undefined")) {
            storeTokens(accessToken, refreshToken);
        } else {
            console.log("Error getting new Access and refresh tokens")
        }
    } catch (error) {
        // handle error
        console.log("Error Replacing Tokens: ", error);
    }
}

// Stores the Withings tokens in a file
async function storeTokens(accessToken, refreshToken) {
    try {
        fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken }));
    } catch (error) {
        console.log("Error storing tokens", error);
    }
}

// Stores most recent execution timestamp to a file
async function storeTime(latestTimestamp) {
    try {
        fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp));
    } catch (error) {
        console.log("Error storing timestamp", error)
    }
}

// Process the data returned by Withings API so it is easier to deal with. Dump unneeded data.
async function processData(scaleData) {
    console.log("Processing data from Withings API");

    let simplifiedData = [];
    for (var i = 0; i < scaleData.measuregrps.length; i++) {
        for (var j = 0; j < scaleData.measuregrps[i].measures.length; j++) {
            let singleEntry = {};
            singleEntry.date = scaleData.measuregrps[i].date;
            let metric = config.metrics[scaleData.measuregrps[i].measures[j].type];
            singleEntry[metric] = scaleData.measuregrps[i].measures[j].value;
            simplifiedData.push(singleEntry);
        }
    }

    var mergedData = simplifiedData.filter(function (v) {
        return this[v.date] ?
            !Object.assign(this[v.date], v) :
            (this[v.date] = v);
    }, {});

    return (mergedData);
}

// Function to read/write CSV directly to Google Drive
async function writeCSVToDrive(mergedData) {
    console.log("Syncing with Google Drive...");

    // Authenticate using the Service Account Key file
    const auth = new google.auth.GoogleAuth({
        keyFile: config.gsheets_key_path,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    let fileContent = "";
    let fileId = null;

    try {
        // 1. Search for existing file
        const listRes = await drive.files.list({
            q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`,
            fields: 'files(id, name)',
        });

        // 2. Download existing content or start fresh
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
        } else {
            // New file header
            fileContent = "sep=,\n" + "date, " + Object.values(config.metrics).join(",") + "\n";
        }

        // 3. Prepare new rows (checking for duplicates)
        // Ensure we handle potentially empty files or single headers correctly
        const existingLines = fileContent ? fileContent.split("\n").map(line => line.split(',')) : [];
        let newContent = "";
        
        for (var k = mergedData.length - 1; k >= 0; k--) {
            var matched = 0;
            // Check if date matches existing rows
            for (var j = 0; j < existingLines.length; j++) {
                if (existingLines[j] && mergedData[k]['date'] == existingLines[j][0]) {
                    matched = 1;
                    break;
                }
            }

            if (matched == 0) {
                // Create CSV line
                var oneLine = mergedData[k]["date"] + "," + 
                              (mergedData[k]["Weight"] || " ") + "," + 
                              (mergedData[k]["Fat Free Mass"] || " ") + "," + 
                              (mergedData[k]["Fat Ratio"] || " ") + "," + 
                              (mergedData[k]["Fat Mass Weight"] || " ") + "," + 
                              (mergedData[k]["Heart Pulse"] || " ") + "," + 
                              (mergedData[k]["Muscle Mass"] || " ") + "," + 
                              (mergedData[k]["Hydration"] || " ") + "," + 
                              (mergedData[k]["Bone Mass"] || " ") + "," + 
                              (mergedData[k]["Pulse Wave Velocity"] || " ") + "\n";
                newContent += oneLine;
            }
        }

        // 4. Update or Create the file
        if (newContent.length > 0) {
            if (fileId) {
                await drive.files.update({
                    fileId: fileId,
                    media: { mimeType: 'text/csv', body: fileContent + newContent }
                });
                console.log("Updated Drive CSV with new data.");
            } else {
                await drive.files.create({
                    resource: { name: config.driveFileName, parents: [config.driveFolderId] },
                    media: { mimeType: 'text/csv', body: fileContent + newContent }
                });
                console.log("Created new CSV in Drive.");
            }
        } else {
            console.log("No new data found.");
        }

    } catch (error) {
        console.log("Drive Error:", error);
    }
}

// Output the latest metrics to an Excel-compatible CSV file (Legacy local)
async function writeCSV(mergedData) {
    var allLines = [];
    var dataLines = [];

    try {
        var allLines = fs.readFileSync(config.csv_output_path).toString().split("\n");
        var dataLines = allLines.slice(2);
    } catch (err) {
        fs.appendFileSync(config.csv_output_path, "sep=,\n");
        var headerLine = "date, " + Object.values(config.metrics).join(",") + "\n";
        fs.appendFileSync(config.csv_output_path, headerLine);
    }

    var splitLines = [];
    for (i in dataLines) {
        splitLines.push(dataLines[i].split(','));
    }

    for (var k = mergedData.length - 1; k >= 0; k--) {
        var matched = 0;
        for (j in splitLines) {
            if (mergedData[k]['date'] == splitLines[j][0]) {
                matched = 1;
            }
        }
        if (matched == 0) {
            var oneLine = mergedData[k]["date"] + "," + mergedData[k]["Weight"] + "," + mergedData[k]["Fat Free Mass"] + "," + mergedData[k]["Fat Ratio"] + "," + mergedData[k]["Fat Mass Weight"] + "," + mergedData[k]["Heart Pulse"] + "," + mergedData[k]["Muscle Mass"] + "," + mergedData[k]["Hydration"] + "," + mergedData[k]["Bone Mass"] + "," + mergedData[k]["Pulse Wave Velocity"] + "\n";
            fs.appendFileSync(config.csv_output_path, oneLine);
        }
    }
    console.log("CSV updated");
}

// Output the latest metrics to a Google Sheet of your choosing
async function writeGSheets(mergedData) {
    console.log("Starting GSheets updates");
    const doc = new GoogleSpreadsheet(config.gSheetsId);
    await doc.useServiceAccountAuth(require(config.gsheets_key_path));
    await doc.loadInfo(); 
    const sheet = doc.sheetsById[config.gSheetsTabId];

    let headerValues = Object.values(config.metrics);
    headerValues.unshift("date");
    await sheet.setHeaderRow(headerValues);

    const rows = await sheet.getRows();

    for (var i = mergedData.length - 1; i >= 0; i--) {
        var matched = 0;
        for (var j = 0; j < rows.length; j++) {
            if (mergedData[i].date == rows[j].date) matched = 1;
        }
        if (matched != 1) {
            var rowArray = [mergedData[i]];
            console.log("Writing Row to GSheets:", mergedData[i].date);
            const moreRows = await sheet.addRows(rowArray, { insert: true })
        }
        if (config.useConorsTabs == true) {
            await conor.updateCurrentAnnualTab(mergedData[i], doc);
        }
    }
    console.log("Finished GSheets updates");
}

// Write metrics to SQLite, CSV and Google Sheets
async function persistData(mergedData) {
    console.log("Persisting data from Withings API");

    // SQLite Logic (Kept as is)
    db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS measurements( date INTEGER PRIMARY KEY, FormattedDate TEXT, Weight REAL, FatFreeMass REAL, FatRatio REAL, FatMassWeight REAL, HeartPulse INTEGER, MuscleMass REAL, Hydration REAL, BoneMass REAL, PulseWaveVelocity REAL, UNIQUE(date))', (err) => {
            if (err) {
                console.log(err);
                throw err;
            }
        });

        for (var i = 0, len = mergedData.length; i < len; i++) {
            let d = new Date(mergedData[i].date * 1000);
            let month = d.getMonth() + 1;
            let formattedDate = d.getFullYear() + "-" + ("0" + month).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
            mergedData[i]["Formatted Date"] = formattedDate;

            if (mergedData[i]["Weight"] === undefined) { mergedData[i]["Weight"] = " "; } else { mergedData[i]["Weight"] = mergedData[i]["Weight"] / 1000; }
            if (mergedData[i]["Fat Free Mass"] === undefined) { mergedData[i]["Fat Free Mass"] = " "; } else { mergedData[i]["Fat Free Mass"] = mergedData[i]["Fat Free Mass"] / 1000; }
            if (mergedData[i]["Fat Ratio"] === undefined) { mergedData[i]["Fat Ratio"] = " "; } else { mergedData[i]["Fat Ratio"] = mergedData[i]["Fat Ratio"] / 1000; }
            if (mergedData[i]["Fat Mass Weight"] === undefined) { mergedData[i]["Fat Mass Weight"] = " "; } else { mergedData[i]["Fat Mass Weight"] = mergedData[i]["Fat Mass Weight"] / 100; }
            if (mergedData[i]["Heart Pulse"] === undefined) mergedData[i]["Heart Pulse"] = " ";
            if (mergedData[i]["Muscle Mass"] === undefined) { mergedData[i]["Muscle Mass"] = " "; } else { mergedData[i]["Muscle Mass"] = mergedData[i]["Muscle Mass"] / 100; }
            if (mergedData[i]["Hydration"] === undefined) { mergedData[i]["Hydration"] = " "; } else { mergedData[i]["Hydration"] = mergedData[i]["Hydration"] / 100; }
            if (mergedData[i]["Bone Mass"] === undefined) { mergedData[i]["Bone Mass"] = " "; } else { mergedData[i]["Bone Mass"] = mergedData[i]["Bone Mass"] / 100; }
            if (mergedData[i]["Pulse Wave Velocity"] === undefined) { mergedData[i]["Pulse Wave Velocity"] = " "; } else { mergedData[i]["Pulse Wave Velocity"] = mergedData[i]["Pulse Wave Velocity"] / 1000; }

            db.run(`INSERT OR IGNORE INTO measurements(date, FormattedDate, Weight, FatFreeMass, FatRatio, FatMassWeight, HeartPulse, MuscleMass, Hydration, BoneMass, PulseWaveVelocity)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, mergedData[i].date, mergedData[i]["Formatted Date"], mergedData[i]["Weight"], mergedData[i]["Fat Free Mass"], mergedData[i]["Fat Ratio"], mergedData[i]["Fat Mass Weight"], mergedData[i]["Heart Pulse"], mergedData[i]["Muscle Mass"], mergedData[i]["Hydration"], mergedData[i]["Bone Mass"], mergedData[i]["Pulse Wave Velocity"], (err) => {
                if (err) {
                    console.log(err);
                    throw err;
                }
            });
        }
    });

    await db.close((err) => {
        if (err) {
            console.error(err.message);
        }
    });
    console.log("SQLite updated");

    for (var k = 0; k < mergedData.length; k++) {
        var d = new Date(mergedData[k].date * 1000);
        var month = d.getMonth() + 1;
        var outputDate = d.getFullYear() + "-" + ("0" + month).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
        mergedData[k].date = outputDate;
    }

    // Write to Google Drive CSV (New)
    await writeCSVToDrive(mergedData);

    // Write to GSheets (Original)
    await writeGSheets(mergedData);

    console.log("All done");
}

// Retrieve all the latest metrics from the Withings API
async function getWithingsData(accessToken, refreshToken, currentTime) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('meastypes', config.metricList);
    bodyFormData.append('startdate', getPreviousTimestamp() + 1);
    bodyFormData.append('enddate', currentTime);

    console.log("Getting data from Withings API");
    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, {
            headers: {
                ...bodyFormData.getHeaders(),
                Authorization: 'Bearer ' + accessToken
            }
        })

        if (response.data.status != 401) {
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else {
            console.log("Problem with tokens. Getting Replacement Access Token. Please re-run to get Withings data.");
            await getReplacementAccessToken(refreshToken);
        }
    } catch (error) {
        console.log("Error Conor1: ", error);
    }
}

module.exports = {
    getPreviousTimestamp,
    getReplacementAccessToken,
    storeTokens,
    storeTime,
    getWithingsData,
    persistData,
    processData,
}
