var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { return 0; }
}

async function getReplacementAccessToken(refreshToken) {
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'requesttoken');
    bodyFormData.append('grant_type', 'refresh_token');
    bodyFormData.append('client_id', config.withingsClientID);
    bodyFormData.append('client_secret', config.withingsClientSecret);
    bodyFormData.append('refresh_token', refreshToken);
    try {
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        if (response.data.body && response.data.body.access_token) {
            storeTokens(response.data.body.access_token, response.data.body.refresh_token);
        }
    } catch (error) { console.log("Error Refreshing Tokens:", error.message); }
}

function storeTokens(accessToken, refreshToken) {
    try { fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error storing tokens", error); }
}

function storeTime(latestTimestamp) {
    try { fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error storing timestamp", error) }
}

async function processData(scaleData) {
    let simplifiedData = [];
    if (scaleData.measuregrps) {
        for (var i = 0; i < scaleData.measuregrps.length; i++) {
            for (var j = 0; j < scaleData.measuregrps[i].measures.length; j++) {
                let singleEntry = { date: scaleData.measuregrps[i].date };
                let metric = config.metrics[scaleData.measuregrps[i].measures[j].type];
                if(metric) {
                    singleEntry[metric] = scaleData.measuregrps[i].measures[j].value;
                    simplifiedData.push(singleEntry);
                }
            }
        }
    }
    // Merges multiple metrics for the same date/time
    var mergedData = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});
    return Object.values(mergedData);
}

async function writeCSVToDrive(mergedData) {
    console.log(`Syncing ${mergedData.length} records to Google Drive...`);
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    // Header Row
    const headerRow = "sep=,\ndate,Weight,Body Fat %,Heart Pulse,Pulse Wave Velocity (m/s),ECG,Vascular Age,Nerve Health Score\n";
    let fileId = null;
    let fileContent = "";

    try {
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, fields: 'files(id, name)' });
        
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            console.log(`Found file ID: ${fileId}. Downloading...`);
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
        }

        // Fix: Ensure we start with a header if the file is truly empty or new
        if (!fileContent || fileContent.trim().length === 0) {
            console.log("File is empty, initializing with headers.");
            fileContent = headerRow;
        }

        // Clean existing lines and handle cases where column 0 isn't the date (headers/sep)
        const existingLines = fileContent.split("\n").map(line => line.trim()).filter(line => line.length > 0);
        const existingDates = existingLines.map(line => line.split(',')[0]);

        let newRows = "";
        let dupeCount = 0;

        for (var k = mergedData.length - 1; k >= 0; k--) {
            // Check if this date already exists in the file
            if (existingDates.includes(mergedData[k].date)) {
                dupeCount++;
            } else {
                newRows += `${mergedData[k].date},${mergedData[k]["Weight"]||""},${mergedData[k]["Body Fat %"]||""},${mergedData[k]["Heart Pulse"]||""},${mergedData[k]["Pulse Wave Velocity (m/s)"]||""},${mergedData[k]["ECG"]||""},${mergedData[k]["Vascular Age"]||""},${mergedData[k]["Nerve Health Score"]||""}\n`;
            }
        }

        console.log(`Summary: ${dupeCount} duplicates found, ${newRows.split('\n').length - 1} new rows to add.`);

        if (newRows.length > 0 || !fileId) {
            const body = (fileId ? fileContent : "") + (fileId && !fileContent.endsWith('\n') ? '\n' : '') + newRows;
            if (fileId) {
                await drive.files.update({ fileId, media: { mimeType: 'text/csv', body } });
                console.log("Successfully updated existing CSV.");
            } else {
                await drive.files.create({ resource: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: (headerRow + newRows) } });
                console.log("Successfully created new CSV.");
            }
        } else {
            console.log("No new data to write.");
        }
    } catch (e) { console.log("Drive Sync Error:", e.message); }
}

async function persistData(mergedData) {
    console.log("Formatting and scaling data for CSV...");
    for (var i = 0; i < mergedData.length; i++) {
        // Scaling and rounding
        if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = (mergedData[i]["Weight"] / 1000).toFixed(2);
        if (mergedData[i]["Body Fat %"]) mergedData[i]["Body Fat %"] = (mergedData[i]["Body Fat %"] / 1000).toFixed(2);
        if (mergedData[i]["Pulse Wave Velocity (m/s)"]) mergedData[i]["Pulse Wave Velocity (m/s)"] = (mergedData[i]["Pulse Wave Velocity (m/s)"] / 1000).toFixed(2);
        
        // Correct scaling for Nerve Health Score
        if (mergedData[i]["Nerve Health Score"]) mergedData[i]["Nerve Health Score"] = (mergedData[i]["Nerve Health Score"] / 1000).toFixed(1);

        // Date conversion to string
        let d = new Date(mergedData[i].date * 1000);
        let month = d.getMonth() + 1;
        mergedData[i].date = `${d.getFullYear()}-${("0"+month).slice(-2)}-${("0"+d.getDate()).slice(-2)} ${("0"+d.getHours()).slice(-2)}:${("0"+d.getMinutes()).slice(-2)}:${("0"+d.getSeconds()).slice(-2)}`;
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
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders(), Authorization: 'Bearer ' + accessToken } });
        if (response.data.status == 0) {
            console.log("Data retrieved from Withings.");
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) { 
            console.log("Withings token expired. Refreshing...");
            await getReplacementAccessToken(refreshToken); 
        } else {
            console.log("Withings API error status:", response.data.status);
        }
    } catch (error) { console.log("Withings API request failed:", error.message); }
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, persistData, processData };
