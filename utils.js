var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
let conor = require('./conor.js');

// SQLite connection
let db = new sqlite3.Database(config.sqlite3_output_path, (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to sqlite3.');
});

// Find out when the code was last run
function getPreviousTimestamp() {
    try {
        timestamp = fs.readFileSync(config.timestamp_path);
        let previousTimestamp = JSON.parse(timestamp);
        return previousTimestamp;
    } catch (err) {
        return 0; // If file doesn't exist, start from 1970
    }
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
            headers: { ...bodyFormData.getHeaders() }
        })
        const accessToken = response.data.body.access_token;
        const refreshToken = response.data.body.refresh_token;

        if (accessToken && refreshToken) {
            storeTokens(accessToken, refreshToken);
        } else {
            console.log("Error getting new Access and refresh tokens")
        }
    } catch (error) {
        console.log("Error Replacing Tokens: ", error);
    }
}

async function storeTokens(accessToken, refreshToken) {
    try {
        fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken }));
    } catch (error) {
        console.log("Error storing tokens", error);
    }
}

async function storeTime(latestTimestamp) {
    try {
        fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp));
    } catch (error) {
        console.log("Error storing timestamp", error)
    }
}

async function processData(scaleData) {
    console.log("Processing data from Withings API...");

    let simplifiedData = [];
    if (scaleData.measuregrps) {
        for (var i = 0; i < scaleData.measuregrps.length; i++) {
            for (var j = 0; j < scaleData.measuregrps[i].measures.length; j++) {
                let singleEntry = {};
                singleEntry.date = scaleData.measuregrps[i].date;
                let metric = config.metrics[scaleData.measuregrps[i].measures[j].type];
                if(metric) {
                    singleEntry[metric] = scaleData.measuregrps[i].measures[j].value;
                    simplifiedData.push(singleEntry);
                }
            }
        }
    }

    var mergedData = simplifiedData.filter(function (v) {
        return this[v.date] ?
            !Object.assign(this[v.date], v) :
            (this[v.date] = v);
    }, {});

    // Turn object back into array
    mergedData = Object.values(mergedData);
    
    console.log(`Found ${mergedData.length} valid measurement groups.`);
    return (mergedData);
}

// Function to read/write CSV directly to Google Drive
async function writeCSVToDrive(mergedData) {
    console.log("Syncing with Google Drive...");

    const auth = new google.auth.GoogleAuth({
        keyFile: config.gsheets_key_path,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    let fileContent = "";
    let fileId = null;
    const headerRow = "sep=,\ndate,Weight,Fat Free Mass,Fat Ratio,Fat Mass Weight,Heart Pulse,Muscle Mass,Hydration,Bone Mass,Vascular Age,ECG,Nerve Health Score\n";

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
            if (!fileContent) fileContent = headerRow; // Handle 0-byte existing files
        } else {
            fileContent = headerRow;
        }

        // 3. Prepare new rows (checking for duplicates)
        const existingLines = fileContent.split("\n").map(line => line.split(','));
        let newContent = "";
        
        for (var k = mergedData.length - 1; k >= 0; k--) {
            var matched = 0;
            for (var j = 0; j < existingLines.length; j++) {
                // Safe check for existing lines
                if (existingLines[j] && existingLines[j].length > 0 && mergedData[k]['date'] == existingLines[j][0]) {
                    matched = 1;
                    break;
                }
            }

            if (matched == 0) {
                var oneLine = mergedData[k]["date"] + "," + 
                              (mergedData[k]["Weight"] || "") + "," + 
                              (mergedData[k]["Fat Free Mass"] || "") + "," + 
                              (mergedData[k]["Fat Ratio"] || "") + "," + 
                              (mergedData[k]["Fat Mass Weight"] || "") + "," + 
                              (mergedData[k]["Heart Pulse"] || "") + "," + 
                              (mergedData[k]["Muscle Mass"] || "") + "," + 
                              (mergedData[k]["Hydration"] || "") + "," + 
                              (mergedData[k]["Bone Mass"] || "") + "," + 
                              (mergedData[k]["Vascular Age"] || "") + "," + 
                              (mergedData[k]["ECG"] || "") + "," + 
                              (mergedData[k]["Nerve Health Score"] || "") + "\n";
                newContent += oneLine;
            }
        }

        // 4. Update or Create the file
        // FIX: We now write if there is new data OR if we need to create the file for the first time
        if (newContent.length > 0 || !fileId) {
            const finalBody = fileContent + newContent;
            
            if (fileId) {
                await drive.files.update({
                    fileId: fileId,
                    media: { mimeType: 'text/csv', body: finalBody }
                });
                console.log(`Updated Drive CSV with ${newContent.split('\n').length - 1} new rows.`);
            } else {
                await drive.files.create({
                    resource: { name: config.driveFileName, parents: [config.driveFolderId] },
                    media: { mimeType: 'text/csv', body: finalBody }
                });
                console.log("Created new CSV file in Drive.");
            }
        } else {
            console.log("No new data to append.");
        }

    } catch (error) {
        console.log("Drive Error:", error);
    }
}

async function persistData(mergedData) {
    console.log("Persisting data...");

    // SQLite Logic
    db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS measurements( date INTEGER PRIMARY KEY, FormattedDate TEXT, Weight REAL, FatFreeMass REAL, FatRatio REAL, FatMassWeight REAL, HeartPulse INTEGER, MuscleMass REAL, Hydration REAL, BoneMass REAL, PulseWaveVelocity REAL, UNIQUE(date))', (err) => {
            if (err) throw err;
        });

        for (var i = 0, len = mergedData.length; i < len; i++) {
            let d = new Date(mergedData[i].date * 1000);
            let month = d.getMonth() + 1;
            let formattedDate = d.getFullYear() + "-" + ("0" + month).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
            mergedData[i]["Formatted Date"] = formattedDate;

            // Unit conversions
            if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = mergedData[i]["Weight"] / 1000;
            if (mergedData[i]["Fat Free Mass"]) mergedData[i]["Fat Free Mass"] = mergedData[i]["Fat Free Mass"] / 1000;
            if (mergedData[i]["Fat Ratio"]) mergedData[i]["Fat Ratio"] = mergedData[i]["Fat Ratio"] / 1000;
            if (mergedData[i]["Fat Mass Weight"]) mergedData[i]["Fat Mass Weight"] = mergedData[i]["Fat Mass Weight"] / 100;
            if (mergedData[i]["Muscle Mass"]) mergedData[i]["Muscle Mass"] = mergedData[i]["Muscle Mass"] / 100;
            if (mergedData[i]["Hydration"]) mergedData[i]["Hydration"] = mergedData[i]["Hydration"] / 100;
            if (mergedData[i]["Bone Mass"]) mergedData[i]["Bone Mass"] = mergedData[i]["Bone Mass"] / 100;
            if (mergedData[i]["Vascular Age"]) mergedData[i]["Vascular Age"] = mergedData[i]["Vascular Age"] / 1000; 

            // SQLite Insert
            db.run(`INSERT OR IGNORE INTO measurements(date, FormattedDate, Weight, FatFreeMass, FatRatio, FatMassWeight, HeartPulse, MuscleMass, Hydration, BoneMass, PulseWaveVelocity)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
              mergedData[i].date, mergedData[i]["Formatted Date"], mergedData[i]["Weight"], mergedData[i]["Fat Free Mass"], mergedData[i]["Fat Ratio"], 
              mergedData[i]["Fat Mass Weight"], mergedData[i]["Heart Pulse"], mergedData[i]["Muscle Mass"], mergedData[i]["Hydration"], mergedData[i]["Bone Mass"], 
              mergedData[i]["Vascular Age"], (err) => { if (err) throw err; });
        }
    });

    await db.close((err) => {
        if (err) console.error(err.message);
    });

    // Format dates for CSV
    for (var k = 0; k < mergedData.length; k++) {
        var d = new Date(mergedData[k].date * 1000);
        var month = d.getMonth() + 1;
        var outputDate = d.getFullYear() + "-" + ("0" + month).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
        mergedData[k].date = outputDate;
    }

    // Write to Google Drive CSV
    await writeCSVToDrive(mergedData);
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    // FIX: Changed 'meastypes' to 'meastype' (singular) as per API standards
    bodyFormData.append('meastype', config.metricList); 
    bodyFormData.append('startdate', getPreviousTimestamp() + 1);
    bodyFormData.append('enddate', currentTime);

    console.log("Requesting data from Withings API...");
    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, {
            headers: {
                ...bodyFormData.getHeaders(),
                Authorization: 'Bearer ' + accessToken
            }
        })

        if (response.data.status == 0) { // Check for Success Status 0
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) {
            console.log("Token expired. Getting Replacement Access Token.");
            await getReplacementAccessToken(refreshToken);
        } else {
            console.log("API Error. Status:", response.data.status, "Message:", JSON.stringify(response.data));
        }
    } catch (error) {
        console.log("Error getting data: ", error);
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
