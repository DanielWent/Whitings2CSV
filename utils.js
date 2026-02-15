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
        scaleData.measuregrps.forEach(grp => {
            grp.measures.forEach(measure => {
                let singleEntry = { date: grp.date };
                let metricName = config.metrics[measure.type];
                
                if (metricName) {
                    // Universal Power-of-10 Scaling
                    let val = measure.value * Math.pow(10, measure.unit);
                    singleEntry[metricName] = val;
                    simplifiedData.push(singleEntry);
                }
            });
        });
    }

    var mergedMap = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});
    
    let result = Object.values(mergedMap);
    result.sort((a, b) => b.date - a.date);
    return result;
}

async function writeCSVToDrive(mergedData) {
    const auth = new google.auth.GoogleAuth({ keyFile: config.gsheets_key_path, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    
    // Updated Header Row (Full names, units included, No Heart Rate)
    const headerRow = "date,Weight (kg),Body Fat (%),Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score\n";
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
        const dataLinesOnly = existingLines.filter(l => !l.startsWith("date"));
        const existingDates = dataLinesOnly.map(line => line.split(',')[0]);

        let newRowsList = [];
        for (var k = 0; k < mergedData.length; k++) {
            if (!existingDates.includes(mergedData[k].date)) {
                // Constructing row using new full property names
                let row = `${mergedData[k].date},${mergedData[k]["Weight (kg)"]||""},${mergedData[k]["Body Fat (%)"]||""},${mergedData[k]["Pulse Wave Velocity (m/s)"]||""},${mergedData[k]["AFib Status"]||""},${mergedData[k]["Vascular Age (years)"]||""},${mergedData[k]["Nerve Health Score"]||""}`;
                newRowsList.push(row);
            }
        }

        if (newRowsList.length > 0) {
            const updatedBody = headerRow + newRowsList.join('\n') + '\n' + dataLinesOnly.join('\n');
            if (fileId) await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: updatedBody } });
            else await drive.files.create({ resource: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: updatedBody } });
            console.log(`Success: Added ${newRowsList.length} records.`);
        } else {
            console.log("No new data to write.");
        }
    } catch (e) { console.log("Drive Sync Error:", e.message); }
}

async function persistData(mergedData) {
    for (var i = 0; i < mergedData.length; i++) {
        // Formatting
        if (mergedData[i]["Weight (kg)"]) mergedData[i]["Weight (kg)"] = mergedData[i]["Weight (kg)"].toFixed(2);
        
        if (mergedData[i]["Body Fat (%)"]) {
            // +3% offset (Changed from 4%)
            let bf = parseFloat(mergedData[i]["Body Fat (%)"]) + 3;
            mergedData[i]["Body Fat (%)"] = bf.toFixed(2);
        }
        
        // Updated key to "Pulse Wave Velocity (m/s)"
        if (mergedData[i]["Pulse Wave Velocity (m/s)"]) mergedData[i]["Pulse Wave Velocity (m/s)"] = mergedData[i]["Pulse Wave Velocity (m/s)"].toFixed(2);
        
        if (mergedData[i]["Nerve Health Score"]) mergedData[i]["Nerve Health Score"] = mergedData[i]["Nerve Health Score"].toFixed(1);
        
        // Updated key to "Vascular Age (years)"
        if (mergedData[i]["Vascular Age (years)"]) mergedData[i]["Vascular Age (years)"] = mergedData[i]["Vascular Age (years)"].toFixed(1);

        // Strict AFib Logic
        if (mergedData[i]["AFib Status"] !== undefined) {
            const res = mergedData[i]["AFib Status"];
            
            // 2, 4 = Detected
            if ([2, 4].includes(res)) {
                mergedData[i]["AFib Status"] = "AFib Detected";
            } 
            // 0, 1, 5, 10 = Not Detected (including High HR)
            else if ([0, 1, 5, 10].includes(res)) {
                mergedData[i]["AFib Status"] = "AFib Not Detected";
            } 
            // Everything else = Inconclusive
            else {
                mergedData[i]["AFib Status"] = "Inconclusive";
            }
        }

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
