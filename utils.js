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
    const enddate = currentTime;

    var bodyFormData = new FormData();
    bodyFormData.append('action', 'getmeas');
    bodyFormData.append('access_token', accessToken);
    bodyFormData.append('startdate', startdate);
    bodyFormData.append('enddate', enddate);
    
    if (config.metricList) {
        bodyFormData.append('meastypes', config.metricList);
    }

    try {
        console.log(`Fetching data from ${new Date(startdate * 1000).toISOString()} to ${new Date(enddate * 1000).toISOString()}...`);
        const response = await axios.post("https://wbsapi.withings.net/measure", bodyFormData, { headers: { ...bodyFormData.getHeaders() } });
        
        if (response.data.status === 401) {
            console.log("Access Token Expired. Refreshing...");
            let newAccessToken = await getReplacementAccessToken(refreshToken);
            if (newAccessToken) return await getWithingsData(newAccessToken, refreshToken, currentTime);
            return null;
        }
        
        if (response.data.status === 0) {
            let mergedData = await processData(response.data.body);
            console.log(`Processed ${mergedData.length} entries.`);
            await persistData(mergedData);
            await storeTime(currentTime);
            return response.data.body;
        } else {
            console.log("API Error Status:", response.data.status);
            return null;
        }
    } catch (error) { console.log("Error getting Withings data:", error.message); return null; }
}

async function processData(scaleData) {
    let simplifiedData = [];
    let unknownIDs = new Set();

    if (scaleData && scaleData.measuregrps) {
        scaleData.measuregrps.forEach(grp => {
            grp.measures.forEach(measure => {
                let singleEntry = { date: grp.date };
                let metricName = config.metrics[measure.type];
                let val = measure.value * Math.pow(10, measure.unit);
                
                if (metricName) {
                    // Body Fat Correction (+3%)
                    if (metricName === "Body Fat (%)") {
                        val = val + 3;
                    }

                    // AFib Interpretation
                    if (metricName === "AFib Status") {
                        if ([2, 4].includes(val)) val = "AFib Detected";
                        else if ([0, 1, 5, 10].includes(val)) val = "AFib Not Detected";
                        else val = "Inconclusive";
                    }

                    singleEntry[metricName] = val;

                    // BMI Calculation
                    if (metricName === "Weight (kg)" && config.height) {
                        singleEntry["BMI"] = val / (config.height * config.height);
                    }
                    
                    simplifiedData.push(singleEntry);
                } else {
                    unknownIDs.add(`${measure.type} (Value: ${val})`);
                }
            });
        });
    }

    if (unknownIDs.size > 0) {
        console.log("--- DEBUG: Unknown IDs Found (Possible Visceral Fat IDs) ---");
        unknownIDs.forEach(id => console.log(`ID: ${id}`));
        console.log("-----------------------------------------------------------");
    }

    var mergedMap = simplifiedData.filter(function (v) {
        return this[v.date] ? !Object.assign(this[v.date], v) : (this[v.date] = v);
    }, {});
    
    let result = Object.values(mergedMap);
    result.sort((a, b) => b.date - a.date);
    return result;
}

function formatRow(item) {
    let d = new Date(item.date * 1000);
    let formattedDate = d.toISOString().replace('T', ' ').substring(0, 19);
    
    let bmi = item["BMI"] ? item["BMI"].toFixed(1) : "";
    let bf = typeof item["Body Fat (%)"] === 'number' ? item["Body Fat (%)"].toFixed(2) : (item["Body Fat (%)"] || "");
    let visceral = item["Visceral Fat Rating"] || "";
    let pwv = typeof item["Pulse Wave Velocity (m/s)"] === 'number' ? item["Pulse Wave Velocity (m/s)"].toFixed(2) : (item["Pulse Wave Velocity (m/s)"] || "");
    
    return `${formattedDate},${item["Weight (kg)"]||""},${bmi},${bf},${visceral},${pwv},${item["AFib Status"]||""},${item["Vascular Age (years)"]||""},${item["Nerve Health Score"]||""}`;
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
        if (fileContent && typeof fileContent === 'string') {
            fileContent.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("date,")).forEach(line => {
                let dateStr = line.split(',')[0];
                if (dateStr) allRowsMap.set(dateStr, line);
            });
        }

        mergedData.forEach(item => {
            let rowStr = formatRow(item);
            allRowsMap.set(rowStr.split(',')[0], rowStr);
        });

        let sortedRows = Array.from(allRowsMap.keys()).sort((a, b) => new Date(b) - new Date(a)).map(d => allRowsMap.get(d));
        let fullCSV = headerRow + "\n" + sortedRows.join("\n") + "\n";

        if (fileId) await drive.files.update({ fileId, media: { mimeType: 'text/csv', body: fullCSV } });
        else await drive.files.create({ requestBody: { name: config.driveFileName, parents: [config.driveFolderId] }, media: { mimeType: 'text/csv', body: fullCSV } });
        console.log("Successfully updated Drive CSV.");
    } catch (error) { console.log("Drive Error:", error.message); }
}

async function persistData(mergedData) {
    if (mergedData.length === 0) return;
    if (!fs.existsSync(config.csv_output_path)) fs.writeFileSync(config.csv_output_path, "date,Weight (kg),BMI,Body Fat (%),Visceral Fat Rating,Pulse Wave Velocity (m/s),AFib Status,Vascular Age (years),Nerve Health Score\n");
    
    let existingDates = new Set(fs.readFileSync(config.csv_output_path, 'utf8').split('\n').map(l => l.split(',')[0]));
    let newLines = mergedData.map(item => formatRow(item)).filter(row => !existingDates.has(row.split(',')[0])).join("\n");
    
    if (newLines.length > 0) {
        fs.appendFileSync(config.csv_output_path, "\n" + newLines);
        console.log("Appended to local CSV.");
    }
    await writeCSVToDrive(mergedData);
}

module.exports = { getPreviousTimestamp, getReplacementAccessToken, storeTokens, storeTime, getWithingsData, processData, persistData };
