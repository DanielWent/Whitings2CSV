var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { return 1577836800; } 
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
            return response.data.body.access_token;
        }
    } catch (error) { console.log("Token Refresh Error:", error.message); }
    return null;
}

function storeTokens(accessToken, refreshToken) {
    try { fs.writeFileSync(config.token_path, JSON.stringify({ accessToken, refreshToken })); } catch (error) { console.log("Error storing tokens", error); }
}

function storeTime(latestTimestamp) {
    try { fs.writeFileSync(config.timestamp_path, JSON.stringify(latestTimestamp)); } catch (error) { console.log("Error storing timestamp", error) }
}

async function getWithingsData(accessToken, refreshToken, currentTime) {
    const startdate = getPreviousTimestamp();
    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('access_token', accessToken);
    bodyFormData.append('startdate', startdate);
    bodyFormData.append('enddate', currentTime);
    
    try {
        console.log("Fetching metrics...");
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        
        if (response.data.status === 401) {
            let newAccessToken = await getReplacementAccessToken(refreshToken);
            if (newAccessToken) return await getWithingsData(newAccessToken, refreshToken, currentTime);
            return null;
        }
        
        if (response.data.status === 0) {
            let mergedData = await processData(response.data.body);
            console.log(`Processed ${mergedData.length} unique records.`);
            await persistData(mergedData);
            await storeTime(currentTime);
            return response.data.body;
        }
    } catch (error) { console.log("API Error:", error.message); return null; }
}

async function processData(scaleData) {
    let dataByDate = new Map();

    if (scaleData && scaleData.measuregrps) {
        scaleData.measuregrps.forEach(grp => {
            let dateKey = grp.date;
            if (!dataByDate.has(dateKey)) dataByDate.set(dateKey, { date: dateKey });
            let entry = dataByDate.get(dateKey);

            grp.measures.forEach(measure => {
                let val = measure.value * Math.pow(10, measure.unit);
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    // 1. Body Fat Correction (+3%)
                    if (metricName === "Body Fat (%)") val = val + 3;

                    // 2. AFib Interpretation
                    if (metricName === "AFib Status") {
                        if ([2, 4].includes(val)) val = "AFib Detected";
                        else if ([0, 1, 5, 10].includes(val)) val = "AFib Not Detected";
                        else val = "Inconclusive";
                    }

                    entry[metricName] = val;

                    // 3. BMI Calculation
                    if (metricName === "Weight (kg)" && config.height) {
                        entry["BMI"] = val / (config.height * config.height);
                    }
                }
            });
        });
    }
    return Array.from(dataByDate.values()).sort((a, b) => b.date - a.date);
}

function formatRow(item) {
    let d = new Date(item.date * 1000);
    let dateStr = d.toISOString().replace('T', ' ').substring(0, 19);
    
    const getVal = (key, decimals = null) => {
        let val = item[key];
        if (val === undefined || val === null) return "";
        if (typeof val === 'number' && decimals !== null) return val.toFixed(decimals);
        return val;
    };

    return [
        dateStr,
        getVal("Weight (kg)", 2),
        getVal("BMI", 1),
        getVal("Body Fat (%)", 2),
        getVal("Visceral Fat Rating", 1),
        getVal("Pulse Wave Velocity (m/s)", 2),
        getVal("AFib Status"),
        getVal("Vascular Age (years)", 1),
        getVal("Nerve Health Score", 1)
    ].join(",");
}

async function writeCSVToDrive(mergedData) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    const headerRow = "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score";
    let fileId = null, fileContent = "";

    try {
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false` });
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
            fileContent = getRes.data;
        }

        let allRowsMap = new Map();
        
        // Parse Existing Content
        if (fileContent && typeof fileContent === 'string') {
            fileContent.split(/\r?\n/).forEach(line => {
                let trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("date,")) {
                    allRowsMap.set(trimmed.split(',')[0], trimmed);
                }
            });
        }

        // Merge New Content
        mergedData.forEach(item => {
            let row = formatRow(item);
            allRowsMap.set(row.split(',')[0], row);
        });

        // Reconstruct Master CSV
        let sortedRows = Array.from(allRowsMap.keys()).sort((a, b) => new Date(b) - new Date(a)).map(d => allRowsMap.get(d));
        let fullCSV = headerRow + "\n" + sortedRows.join("\n") + "\n";

        console.log(`Sending ${sortedRows.length} rows to Google Drive...`);

        if (fileId) {
            await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: fullCSV } });
        } else {
            await drive.files.create({ requestBody: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: fullCSV } });
        }
        console.log("Successfully updated Drive CSV.");
    } catch (error) { console.log("Drive Error:", error.message); }
}

async function persistData(mergedData) {
    if (mergedData.length === 0) return;
    await writeCSVToDrive(mergedData);
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, processData, persistData };
