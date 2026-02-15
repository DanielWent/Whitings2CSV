var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Replaced LevelDB with SQLite
let db = new sqlite3.Database(config.sqlite3_output_path, (err) => {
    if (err) console.error(err.message);
});

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) {
        return 0;
    }
}

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
        if (response.data.body && response.data.body.access_token) {
            storeTokens(response.data.body.access_token, response.data.body.refresh_token);
        }
    } catch (error) {
        console.log("Error Replacing Tokens: ", error);
    }
}

function storeTokens(accessToken, refreshToken) {
    try {
        fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken }));
    } catch (error) {
        console.log("Error storing tokens", error);
    }
}

function storeTime(latestTimestamp) {
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
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});

    return Object.values(mergedData);
}

// Logic to write directly to Google Drive
async function writeCSVToDrive(mergedData) {
    console.log("Syncing with Google Drive...");
    const auth = new google.auth.GoogleAuth({
        keyFile: config.gsheets_key_path,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    let fileContent = "";
    let fileId = null;
    const headerRow = "sep=,\ndate,Weight,Body Fat %,Heart Pulse,Pulse Wave Velocity (m/s),ECG,Vascular Age,Nerve Health Score\n";

    try {
        const listRes = await drive.files.list({
            q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`,
            fields: 'files(id, name)',
        });

        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
            if (!fileContent) fileContent = headerRow;
        } else {
            fileContent = headerRow;
        }

        const existingLines = fileContent.split("\n").map(line => line.split(','));
        let newContent = "";
        
        for (var k = mergedData.length - 1; k >= 0; k--) {
            var matched = 0;
            for (var j = 0; j < existingLines.length; j++) {
                if (existingLines[j] && mergedData[k]['date'] == existingLines[j][0]) {
                    matched = 1;
                    break;
                }
            }

            if (matched == 0) {
                var oneLine = mergedData[k]["date"] + "," + 
                              (mergedData[k]["Weight"] || "") + "," + 
                              (mergedData[k]["Body Fat %"] || "") + "," + 
                              (mergedData[k]["Heart Pulse"] || "") + "," + 
                              (mergedData[k]["Pulse Wave Velocity (m/s)"] || "") + "," + 
                              (mergedData[k]["ECG"] || "") + "," + 
                              (mergedData[k]["Vascular Age"] || "") + "," + 
                              (mergedData[k]["Nerve Health Score"] || "") + "\n";
                newContent += oneLine;
            }
        }

        if (newContent.length > 0 || !fileId) {
            const finalBody = fileContent + newContent;
            if (fileId) {
                await drive.files.update({ fileId: fileId, media: { mimeType: 'text/csv', body: finalBody } });
                console.log("Updated Drive CSV.");
            } else {
                await drive.files.create({
                    resource: { name: config.driveFileName, parents: [config.driveFolderId] },
                    media: { mimeType: 'text/csv', body: finalBody }
                });
                console.log("Created new CSV.");
            }
        }
    } catch (error) {
        console.log("Drive Error:", error);
    }
}

async function persistData(mergedData) {
    console.log("Persisting data...");
    for (var i = 0, len = mergedData.length; i < len; i++) {
        // Unit Scaling and Fixed Decimals
        if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = (mergedData[i]["Weight"] / 1000).toFixed(2);
        if (mergedData[i]["Body Fat %"]) mergedData[i]["Body Fat %"] = (mergedData[i]["Body Fat %"] / 1000).toFixed(2);
        if (mergedData[i]["Pulse Wave Velocity (m/s)"]) mergedData[i]["Pulse Wave Velocity (m/s)"] = (mergedData[i]["Pulse Wave Velocity (m/s)"] / 1000).toFixed(2);
        if (mergedData[i]["Nerve Health Score"]) mergedData[i]["Nerve Health Score"] = (mergedData[i]["Nerve Health Score"] / 1000).toFixed(1);

        // Standardized Date Formatting
        let d = new Date(mergedData[i].date * 1000);
        let month = d.getMonth() + 1;
        mergedData[i].date = d.getFullYear() + "-" + ("0" + month).slice(-2) + "-" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    }

    await writeCSVToDrive(mergedData);
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('meastypes', config.metricList); 
    bodyFormData.append('startdate', getPreviousTimestamp() + 1);
    bodyFormData.append('enddate', currentTime);

    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, {
            headers: { ...bodyFormData.getHeaders(), Authorization: 'Bearer ' + accessToken }
        })
        if (response.data.status == 0) {
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) {
            await getReplacementAccessToken(refreshToken);
        }
    } catch (error) {
        console.log("Error getting data: ", error);
    }
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, persistData, processData };
