var config = require('./config');
const { google } = require('googleapis');
const FormData = require('form-data');
const fs = require("fs");
const axios = require('axios');

function getPreviousTimestamp() {
    try {
        let timestamp = fs.readFileSync(config.timestamp_path);
        return JSON.parse(timestamp);
    } catch (err) { 
        return 1577836800; // Start from 2020
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
        const response = await axios.post("https://wbsapi.withings.net/v2/oauth2", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        if (response.data.body && response.data.body.access_token) {
            storeTokens(response.data.body.access_token, response.data.body.refresh_token);
        }
    } catch (error) { console.log("Token Refresh Error:", error.message); }
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
    var mergedMap = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});
    
    // Sort array by date (descending) so most recent is first
    let result = Object.values(mergedMap);
    result.sort((a, b) => b.date - a.date);
    return result;
}

async function writeCSVToDrive(mergedData) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    const headerRow = "date,Weight,Body Fat %,Heart Pulse,Pulse Wave Velocity (m/s),ECG,Vascular Age,Nerve Health Score\n";
    let fileId = null;
    let fileContent = "";

    try {
        const listRes = await drive.files.list({ q: `'${config.driveFolderId}' in parents and name = '${config.driveFileName}' and trashed = false`, fields: 'files(id, name)' });
        if (listRes.data.files.length > 0) {
            fileId = listRes.data.files[0].id;
            const getRes = await drive.files.get({ fileId: fileId, alt: 'media' });
            fileContent = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
        }

        const existingLines = (fileContent || "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        // Remove header from existing lines for logical merging
        const dataLinesOnly = existingLines.filter(l => !l.startsWith("date"));
        const existingDates = dataLinesOnly.map(line => line.split(',')[0]);

        let newRowsList = [];
        for (var k = 0; k < mergedData.length; k++) {
            if (!existingDates.includes(mergedData[k].date)) {
                let row = `${mergedData[k].date},${mergedData[k]["Weight"]||""},${mergedData[k]["Body Fat %"]||""},${mergedData[k]["Heart Pulse"]||""},${mergedData[k]["Pulse Wave Velocity (m/s)"]||""},${mergedData[k]["ECG"]||""},${mergedData[k]["Vascular Age"]||""},${mergedData[k]["Nerve Health Score"]||mergedData[k]["Nerve Health Score (Advanced)"]||""}`;
                newRowsList.push(row);
            }
        }

        if (newRowsList.length > 0) {
            // Combine Header + New Rows + Old Data
            const updatedBody = headerRow + newRowsList.join('\n') + '\n' + dataLinesOnly.join('\n');
            
            if (fileId) {
                await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: updatedBody } });
                console.log("CSV updated with most recent entries at the top.");
            } else {
                await drive.files.create({ resource: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: updatedBody } });
                console.log("New CSV created.");
            }
        }
    } catch (e) { console.log("Drive Sync Error:", e.message); }
}

async function persistData(mergedData) {
    for (var i = 0; i < mergedData.length; i++) {
        // 1. Weight Scaling
        if (mergedData[i]["Weight"]) mergedData[i]["Weight"] = (mergedData[i]["Weight"] / 1000).toFixed(2);
        
        // 2. Body Fat % + 4% Correction
        if (mergedData[i]["Body Fat %"]) {
            let bf = (mergedData[i]["Body Fat %"] / 1000) + 4;
            mergedData[i]["Body Fat %"] = bf.toFixed(2);
        }
        
        // 3. PWV Scaling
        if (mergedData[i]["Pulse Wave Velocity (m/s)"]) mergedData[i]["Pulse Wave Velocity (m/s)"] = (mergedData[i]["Pulse Wave Velocity (m/s)"] / 1000).toFixed(2);
        
        // 4. Nerve Health Scaling
        if (mergedData[i]["Nerve Health Score"]) mergedData[i]["Nerve Health Score"] = (mergedData[i]["Nerve Health Score"] / 1000).toFixed(1);
        if (mergedData[i]["Nerve Health Score (Advanced)"]) mergedData[i]["Nerve Health Score (Advanced)"] = (mergedData[i]["Nerve Health Score (Advanced)"] / 1000).toFixed(1);

        // 5. Vascular Age Fix (Handling codes like 401)
        if (mergedData[i]["Vascular Age"]) {
            let vAge = mergedData[i]["Vascular Age"];
            if (vAge > 150) { // Likely an error code or status
                mergedData[i]["Vascular Age"] = "N/A";
            } else {
                mergedData[i]["Vascular Age"] = vAge;
            }
        }

        // 6. Refined ECG Logic
        if (mergedData[i]["ECG"] !== undefined) {
            const res = mergedData[i]["ECG"];
            // Withings Status Codes: 0 = Normal, 1 = Normal (Alt), 9/10 = Inconclusive
            if (res === 0 || res === 1) mergedData[i]["ECG"] = "Normal";
            else if (res === 2 || res === 4) mergedData[i]["ECG"] = "AFib Detected";
            else if (res === 9) mergedData[i]["ECG"] = "Inconclusive (HR Low)";
            else if (res === 10) mergedData[i]["ECG"] = "Inconclusive (HR High)";
            else mergedData[i]["ECG"] = "Normal"; // Defaulting to normal for status 0 or others
        }

        // Date Formatting
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
    bodyFormData.append('startdate', getPreviousTimestamp());
    bodyFormData.append('enddate', currentTime);
    try {
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders(), Authorization: 'Bearer ' + accessToken } });
        if (response.data.status == 0) {
            var mergedData = await processData(response.data.body);
            await persistData(mergedData);
            await storeTime(currentTime);
        } else if (response.data.status == 401) { await getReplacementAccessToken(refreshToken); }
    } catch (error) { console.log("Withings API Fetch Error:", error.message); }
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, persistData, processData };
